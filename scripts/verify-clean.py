"""Inspect actual release bytes, and optionally re-extract into an empty location."""
import argparse
import hashlib
import json
import pathlib
import re
import zipfile


def verify(archive, expected_commit, extract=None):
    with zipfile.ZipFile(archive) as z:
        members = z.infolist()
        names = [entry.filename for entry in members]
        if len(names) != len(set(name.casefold() for name in names)):
            raise ValueError('Duplicate/case-colliding ZIP entries')
        for name in names:
            p = pathlib.PurePosixPath(name)
            if p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name or p.parts[0] != 'Malay-TTS-Bot':
                raise ValueError(f'Unsafe package path: {name}')
        prefix = 'Malay-TTS-Bot/'
        manifest = json.loads(z.read(prefix + 'release-manifest.json'))
        if manifest['sourceCommit'] != expected_commit:
            raise ValueError('ZIP source commit does not match the validated commit')
        if set(names) != {prefix + name for name in manifest['files']} | {prefix + 'release-manifest.json'}:
            raise ValueError('Archive and manifest inventories differ')
        node_root = f'runtime/node-v{manifest["runtimes"]["node"]["version"]}-win-x64/'
        for name, expected_hash in manifest['files'].items():
            data = z.read(prefix + name)
            if hashlib.sha256(data).hexdigest() != expected_hash:
                raise ValueError(f'File checksum mismatch: {name}')
            # The official portable npm tree is required; app node_modules is forbidden.
            if not name.startswith(node_root):
                if re.search(r'(^|/)(\.env|\.git|node_modules|data|temp|bot(?:-old)?\.log)(/|$)', name, re.I) or re.search(r'\.(?:bak|tmp|pcm|lock|download)$', name, re.I):
                    raise ValueError(f'Private/generated content in ZIP: {name}')
            if name.endswith('.json'):
                json.loads(data)
        package = json.loads(z.read(prefix + 'package.json'))
        if manifest['version'] != package['version']:
            raise ValueError('Package and manifest versions differ')
        if extract:
            target = extract / 'Malay-TTS-Bot'
            if target.exists():
                raise FileExistsError(f'Refusing to extract over {target}')
            extract.mkdir(parents=True, exist_ok=True)
            z.extractall(extract)
        print(f'Validated CLEAN ZIP: {len(names)} members; version {manifest["version"]}; source {expected_commit}')
        return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=pathlib.Path)
    parser.add_argument('--expected-commit', required=True)
    parser.add_argument('--extract', type=pathlib.Path)
    args = parser.parse_args()
    verify(args.archive, args.expected_commit, args.extract)
