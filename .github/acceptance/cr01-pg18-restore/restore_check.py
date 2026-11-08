#!/usr/bin/env python3
"""Isolated PostgreSQL 18 restore check. NEVER fetches, transmits, or archives backup content.

No production credentials, no DATABASE_URL, and no network endpoints except the
runner-local PostgreSQL test service at 127.0.0.1:5432.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

CLIENT_IMAGE = "postgres:18-alpine"
DB_NAME = "cc_restore_probe"
DB_USER = "cc_restore_limited"
DB_PASSWORD = "ci-restore-test-only"  # Not a production secret; disposable database.
PG_HOST = "127.0.0.1"
PG_PORT = "5432"
MAX_MEMBER_COUNT = 100000
MAX_UNPACKED_SIZE = 10 * 1024 ** 3  # Only a ceiling; not a capacity guarantee.


class RestoreFailure(Exception):
    pass


def digest_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def unpack_archive(archive: Path, target: Path) -> Path:
    """Extract regular files/directories only. Deny links, special files, traversal and duplicate paths."""
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    seen = set()
    total = 0
    try:
        with tarfile.open(archive, mode="r|gz") as inp:
            member_count = 0
            # Stream tar headers: getmembers() builds an unbounded list before the
            # entry-count gate, allowing archive metadata exhaustion.
            for item in inp:
                member_count += 1
                if member_count > MAX_MEMBER_COUNT:
                    raise RestoreFailure("Invalid archive entry count")
                normalized_name = item.name.removeprefix("./")
                p = PurePosixPath(normalized_name)
                if (not normalized_name or normalized_name.startswith("/") or
                        not p.parts or any(s in ("..", ".") for s in p.parts) or
                        "\\" in normalized_name or ":" in normalized_name or
                        not (item.isfile() or item.isdir())):
                    raise RestoreFailure("Unsafe archive member type or path")
                if str(p) in seen:
                    raise RestoreFailure("Duplicate archive path")
                seen.add(str(p))
                total += item.size
                if total > MAX_UNPACKED_SIZE:
                    raise RestoreFailure("Archive exceeds configured extraction bound")
                dest = target.joinpath(*p.parts)
                if item.isdir():
                    dest.mkdir(parents=True, exist_ok=True, mode=0o700)
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                source = inp.extractfile(item)
                if source is None:
                    raise RestoreFailure("Archive member cannot be read")
                with source, dest.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                dest.chmod(0o600)
            if member_count == 0:
                raise RestoreFailure("Invalid archive entry count")
    except (OSError, tarfile.TarError) as exc:
        raise RestoreFailure("Archive decompression failed") from exc
    tocs = list(target.rglob("toc.dat"))
    if len(tocs) != 1:
        raise RestoreFailure("Expected exactly one PostgreSQL directory-format toc.dat")
    dump_dir = tocs[0].parent
    if not dump_dir.is_dir() or not any(dump_dir.iterdir()):
        raise RestoreFailure("Empty PostgreSQL directory-format dump")
    return dump_dir


def psql_sql(sql: str, *, user: str = DB_USER, db: str = DB_NAME) -> str:
    return docker_client([
        "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
        "-h", PG_HOST, "-p", PG_PORT, "-U", user, "-d", db, "-c", sql,
    ])


def docker_client(client_args: list[str], *, mount: Path | None = None) -> str:
    cmd = [
        "docker", "run", "--rm", "--network", "host",
        "--user", f"{os.getuid()}:{os.getgid()}",
        "--security-opt", "no-new-privileges",
        "--cap-drop", "ALL",
        "--env", f"PGPASSWORD={DB_PASSWORD}",
    ]
    if mount:
        # Read-only data mount: never write restored data back into the export directory.
        cmd += ["--mount", f"type=bind,src={mount},dst=/backup,readonly"]
    cmd += [CLIENT_IMAGE, *client_args]
    if os.environ.get("DOCKER_HOST") or os.environ.get("DOCKER_CONTEXT"):
        raise RestoreFailure("Refused: nondefault Docker routing environment")
    try:
        result = subprocess.run(cmd, text=True, capture_output=True, timeout=1200, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RestoreFailure("Local PG18 client execution failed or timed out") from exc
    if result.returncode != 0:
        # Error output might contain SQL identifiers or data: NEVER print it or upload it.
        raise RestoreFailure("PG18 client step failed (raw DB output intentionally withheld)")
    return result.stdout.strip()


def restore(dump_dir: Path) -> dict:
    # Separate fixed-endpoint identity check. No DATABASE_URL or user-supplied host accepted.
    identity = psql_sql(
        "SELECT current_setting('server_version_num')::integer / 10000,"
        "current_database(), current_setting('port')"
    ).split("|")
    # With Docker published ports the server reports its bridge IP, not 127.0.0.1.
    # Network target remains the hardcoded client-side 127.0.0.1 above.
    if identity != ["18", DB_NAME, PG_PORT]:
        raise RestoreFailure("Refused: database identity / loopback isolation mismatch")
    before = psql_sql("SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")
    if before != "0":
        raise RestoreFailure("Refused: target test database is not empty")

    list_output = docker_client(["pg_restore", "--list", "/backup"], mount=dump_dir)
    toc_entries = sum(1 for s in list_output.splitlines() if s and not s.startswith(";"))
    if toc_entries == 0:
        raise RestoreFailure("No objects found in dump catalog")
    docker_client([
        "pg_restore", "--no-owner", "--no-acl", "--exit-on-error", "--single-transaction",
        "-h", PG_HOST, "-p", PG_PORT, "-U", DB_USER, "-d", DB_NAME, "/backup",
    ], mount=dump_dir)
    count = psql_sql("SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")
    if not count.isdigit() or int(count) < 1:
        raise RestoreFailure("Restore produced no ordinary table; independent review required")
    return {"status": "PASS", "postgres_major": 18,
            "target": "disposable-loopback-only", "table_count": int(count),
            "catalog_entries": toc_entries, "archive_bytes_uploaded": 0}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", type=Path, required=True)
    ap.add_argument("--sha256", required=True)
    ap.add_argument("--report", type=Path, required=True)
    args = ap.parse_args()
    if not re.fullmatch(r"[0-9a-fA-F]{64}", args.sha256):
        print("BLOCKED: invalid expected checksum", file=sys.stderr)
        return 2
    archive = args.archive.resolve()
    if not archive.is_file():
        print("BLOCKED: archive not present on runner", file=sys.stderr)
        return 2
    actual = digest_file(archive)
    if actual != args.sha256.lower():
        print("FAIL: SHA-256 mismatch before extraction", file=sys.stderr)
        return 2
    try:
        with tempfile.TemporaryDirectory(prefix="cc-pg18-check-") as scratch:
            dump = unpack_archive(archive, Path(scratch) / "unpacked")
            result = restore(dump)
        # Safe numeric-only report. It contains no names, SQL, table contents or credentials.
        args.report.write_text(json.dumps(result, sort_keys=True) + "\n", encoding="utf-8")
        print("PASS: isolated PostgreSQL 18 restore and non-empty table catalog verified")
        return 0
    except RestoreFailure as exc:
        print(f"NOT VERIFIED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
