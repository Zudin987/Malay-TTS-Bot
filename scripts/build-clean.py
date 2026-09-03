"""Build a deterministic CLEAN Windows ZIP from tracked, allowlisted source."""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCES = json.loads((ROOT / 'scripts/runtime-sources.json').read_text())
TOP = 'Malay-TTS-Bot'
ROOT_FILES = {'.env.example', 'package.json', 'package-lock.json', 'README.md', 'MAINTENANCE.md', 'RELEASE-NOTES.md', 'THIRD-PARTY-NOTICES.md', 'deploy-commands.js', 'install-task.ps1'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def allowed_source(name):
    p = pathlib.PurePosixPath(name)
    return name in ROOT_FILES or (len(p.parts) == 1 and p.suffix in ('.cmd', '.vbs')) or (p.parts[0] == 'src' and p.suffix == '.js') or (p.parts[0] == 'config' and p.suffix == '.json')


def safe_name(name):
    p = pathlib.PurePosixPath(name)
    if '\\' in name or p.is_absolute() or '..' in p.parts or ':' in name:
        raise ValueError(f'Unsafe archive path: {name}')
    return p


def fetch_archives(destination):
    destination.mkdir(parents=True, exist_ok=True)
    for info in SOURCES.values():
        target = destination / info['file']
        if not target.exists():
            request = urllib.request.Request(info['url'], headers={'User-Agent': 'Malay-TTS-Bot-clean-builder'})
            temp = target.with_suffix('.download')
            try:
                with urllib.request.urlopen(request, timeout=90) as response, temp.open('wb') as output:
                    total = 0
                    while chunk := response.read(1024 * 1024):
                        total += len(chunk)
                        if total > 200 * 1024 * 1024:
                            raise ValueError('Runtime archive exceeded 200 MiB')
                        output.write(chunk)
                temp.replace(target)
            finally:
                temp.unlink(missing_ok=True)
        if digest(target.read_bytes()) != info['sha256']:
            raise ValueError(f'Runtime archive checksum mismatch: {target.name}')
        print(f'Verified runtime archive: {target.name}')


def build(archives, output, commit):
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('A full source commit SHA is required')
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    files = {}
    for name in sorted(filter(None, tracked)):
        if allowed_source(name):
            source = ROOT / name
            if source.is_symlink():
                raise ValueError(f'Symlinks are not shipped: {name}')
            files[name] = source.read_bytes()
    for required in ROOT_FILES:
        if required not in files:
            raise ValueError(f'Missing tracked release file: {required}')
    for kind, info in SOURCES.items():
        archive = archives / info['file']
        if digest(archive.read_bytes()) != info['sha256']:
            raise ValueError(f'Runtime archive checksum mismatch: {archive.name}')
        with zipfile.ZipFile(archive) as z:
            for entry in z.infolist():
                p = safe_name(entry.filename)
                if entry.is_dir():
                    continue
                if len(p.parts) < 2 or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('Unexpected runtime member')
                if kind == 'node':
                    if p.parts[0] != f'node-v{info["version"]}-win-x64':
                        raise ValueError('Unexpected Node runtime root')
                    target = 'runtime/' + p.as_posix()
                else:
                    relative = pathlib.PurePosixPath(*p.parts[1:])
                    # Keep the standalone executable and its distribution notices.
                    if relative.as_posix() != 'bin/ffmpeg.exe' and len(relative.parts) != 1:
                        continue
                    target = 'runtime/ffmpeg/' + relative.as_posix()
                if target in files:
                    raise ValueError(f'Duplicate package path: {target}')
                files[target] = z.read(entry)
    node_exe = f'runtime/node-v{SOURCES["node"]["version"]}-win-x64/node.exe'
    if digest(files[node_exe]) != SOURCES['node']['executableSha256']:
        raise ValueError('Bundled node.exe checksum mismatch')
    for required in ['runtime/ffmpeg/bin/ffmpeg.exe', f'runtime/node-v{SOURCES["node"]["version"]}-win-x64/node_modules/npm/bin/npm-cli.js']:
        if required not in files:
            raise ValueError(f'Missing runtime component: {required}')
    version = json.loads(files['package.json'])['version']
    manifest = {'version': version, 'sourceCommit': commit, 'runtimes': SOURCES, 'files': {name: digest(data) for name, data in sorted(files.items())}}
    files['release-manifest.json'] = (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode()
    output.mkdir(parents=True, exist_ok=True)
    target = output / f'Malay-TTS-Bot-v{version}-CLEAN.zip'
    if target.exists():
        raise FileExistsError(f'Refusing to overwrite {target}')
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for name, data in sorted(files.items()):
            entry = zipfile.ZipInfo(f'{TOP}/{name}', date_time=(2020, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(entry, data, compresslevel=6)
    (output / (target.name + '.sha256')).write_text(f'{digest(target.read_bytes())}  {target.name}\n')
    print(f'Built {target.name}: {len(files)} files, {target.stat().st_size} bytes, source {commit}')
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--archives', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, default=ROOT / 'dist')
    parser.add_argument('--commit')
    parser.add_argument('--fetch-only', action='store_true')
    args = parser.parse_args()
    fetch_archives(args.archives)
    if not args.fetch_only:
        build(args.archives, args.output, args.commit)
