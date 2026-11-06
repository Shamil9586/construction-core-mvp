#!/usr/bin/env python3
"""Synthetic, data-free negative checks. No PostgreSQL or network required."""
import hashlib
from io import BytesIO
from pathlib import Path
import tarfile
from tempfile import TemporaryDirectory
import unittest
from restore_check import RestoreFailure, digest_file, unpack_archive


class ArchiveSafetyTests(unittest.TestCase):
    def make_archive(self, file_path: Path, names, *, kind="file"):
        with tarfile.open(file_path, "w:gz") as tf:
            for name in names:
                data = b"synthetic-only"
                item = tarfile.TarInfo(name)
                if kind == "symlink":
                    item.type = tarfile.SYMTYPE
                    item.linkname = "/etc/passwd"
                    tf.addfile(item)
                else:
                    item.size = len(data)
                    tf.addfile(item, BytesIO(data))

    def test_good_dir_archive(self):
        with TemporaryDirectory() as w:
            p = Path(w)
            arc = p / "good.dir.tar.gz"
            self.make_archive(arc, ["pgdir/toc.dat", "pgdir/0001.dat.gz"])
            self.assertEqual(unpack_archive(arc, p / "work").name, "pgdir")
            self.assertEqual(len(digest_file(arc)), 64)

    def test_traversal_rejected(self):
        with TemporaryDirectory() as w:
            p = Path(w)
            arc = p / "bad.dir.tar.gz"
            self.make_archive(arc, ["../outside", "pgdir/toc.dat"])
            with self.assertRaises(RestoreFailure):
                unpack_archive(arc, p / "work")
            self.assertFalse((p / "outside").exists())

    def test_symlink_rejected(self):
        with TemporaryDirectory() as w:
            p = Path(w)
            arc = p / "bad.dir.tar.gz"
            self.make_archive(arc, ["pgdir/toc.dat"], kind="symlink")
            with self.assertRaises(RestoreFailure):
                unpack_archive(arc, p / "work")

    def test_missing_catalog_rejected(self):
        with TemporaryDirectory() as w:
            p = Path(w)
            arc = p / "bad.dir.tar.gz"
            self.make_archive(arc, ["pgdir/0001.dat.gz"])
            with self.assertRaises(RestoreFailure):
                unpack_archive(arc, p / "work")

    def test_multiple_catalogs_rejected(self):
        with TemporaryDirectory() as w:
            p = Path(w)
            arc = p / "bad.dir.tar.gz"
            self.make_archive(arc, ["pgdir/toc.dat", "other/toc.dat"])
            with self.assertRaises(RestoreFailure):
                unpack_archive(arc, p / "work")


if __name__ == "__main__":
    unittest.main(verbosity=2)
