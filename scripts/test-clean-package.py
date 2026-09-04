import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('verify_clean', pathlib.Path(__file__).with_name('verify-clean.py'))
verify_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify_module)
COMMIT = 'a' * 40


class CleanPackageTest(unittest.TestCase):
    def make_zip(self, root, extra=None, corrupt=False):
        files = {'package.json': b'{"version":"0.24.0"}', 'config/settings.json': b'{}', '.env.example': b'GEMINI_API_KEY=\n'}
        files.update(extra or {})
        manifest = {'version': '0.24.0', 'sourceCommit': COMMIT, 'runtimes': {'node': {'version': '24.19.0'}}, 'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
        archive = root / 'package.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            for name, data in files.items():
                z.writestr('Malay-TTS-Bot/' + name, b'tampered' if corrupt and name == 'config/settings.json' else data)
            z.writestr('Malay-TTS-Bot/release-manifest.json', json.dumps(manifest))
        return archive

    def test_inspects_real_zip_then_extracts_without_overwriting(self):
        with tempfile.TemporaryDirectory() as name:
            root = pathlib.Path(name)
            archive = self.make_zip(root)
            target = root / 'unpacked'
            verify_module.verify(archive, COMMIT, target)
            self.assertEqual((target / 'Malay-TTS-Bot/.env.example').read_text(), 'GEMINI_API_KEY=\n')
            with self.assertRaises(FileExistsError):
                verify_module.verify(archive, COMMIT, target)

    def test_rejects_private_data_even_with_a_matching_manifest(self):
        for name in ['.env', 'data/guilds.json', 'node_modules/pkg/index.js', 'bot.log', 'data/bot.log', 'data/speaker-label-cache/example.pcm']:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as folder:
                root = pathlib.Path(folder)
                with self.assertRaisesRegex(ValueError, 'Private/generated'):
                    verify_module.verify(self.make_zip(root, {name: b'{}'}), COMMIT)

    def test_rejects_changed_bytes_and_wrong_source_commit(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                verify_module.verify(self.make_zip(root, corrupt=True), COMMIT)
            with self.assertRaisesRegex(ValueError, 'source commit'):
                verify_module.verify(self.make_zip(root), 'b' * 40)


if __name__ == '__main__':
    unittest.main()
