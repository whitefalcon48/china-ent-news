from __future__ import annotations

import tempfile
import unittest
from ftplib import error_perm
from pathlib import Path

from deploy_lolipop import collect_files, deploy_files, normalize_remote_dir


class FakeFtps:
    def __init__(self) -> None:
        self.directories: set[str] = set()
        self.uploads: list[tuple[str, bytes]] = []
        self.current_directory = ""

    def cwd(self, dirname: str) -> str:
        if dirname not in self.directories:
            raise error_perm("550 directory does not exist")
        self.current_directory = dirname
        return dirname

    def mkd(self, dirname: str) -> str:
        if dirname in self.directories:
            raise error_perm("550 directory already exists")
        self.directories.add(dirname)
        return dirname

    def storbinary(self, command: str, fp) -> str:
        self.uploads.append((command, fp.read()))
        return "226 transfer complete"


class LolipopDeployTest(unittest.TestCase):
    def test_remote_directory_rejects_root_and_parent_traversal(self) -> None:
        for unsafe in ("", "/", "../bingtangnews", "bingtangnews/../other"):
            with self.subTest(unsafe=unsafe), self.assertRaises(ValueError):
                normalize_remote_dir(unsafe)

    def test_index_pages_are_uploaded_after_assets_and_root_index_is_last(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir)
            (source / "assets").mkdir()
            (source / "archive" / "2026-08-11").mkdir(parents=True)
            (source / "assets" / "site.css").write_text("css", encoding="utf-8")
            (source / "archive" / "2026-08-11" / "index.html").write_text("archive", encoding="utf-8")
            (source / "index.html").write_text("home", encoding="utf-8")

            ordered = [path.relative_to(source).as_posix() for path in collect_files(source)]

            self.assertEqual(ordered[0], "assets/site.css")
            self.assertEqual(ordered[-1], "index.html")

    def test_collect_files_ignores_github_pages_nojekyll_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir)
            (source / ".nojekyll").write_text("", encoding="utf-8")
            (source / "index.html").write_text("home", encoding="utf-8")

            ordered = [path.relative_to(source).as_posix() for path in collect_files(source)]

            self.assertEqual(ordered, ["index.html"])

    def test_deploy_creates_directories_and_uploads_root_index_last(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir)
            (source / "assets").mkdir()
            (source / "assets" / "logo.png").write_bytes(b"png")
            (source / "index.html").write_text("home", encoding="utf-8")
            client = FakeFtps()

            count = deploy_files(client, source, "bingtangnews")

            self.assertEqual(count, 2)
            self.assertEqual(client.current_directory, "bingtangnews")
            self.assertIn("assets", client.directories)
            self.assertEqual(client.uploads[-1][0], "STOR index.html")


if __name__ == "__main__":
    unittest.main()
