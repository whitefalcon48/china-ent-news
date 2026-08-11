from __future__ import annotations

import argparse
import os
import posixpath
import ssl
import sys
import time
from dataclasses import dataclass
from ftplib import FTP_TLS, all_errors, error_perm
from pathlib import Path
from typing import BinaryIO, Protocol


RETRYABLE_ERRORS = (*all_errors, ssl.SSLError, TimeoutError)


class FtpsClient(Protocol):
    def mkd(self, dirname: str) -> str: ...

    def storbinary(self, command: str, fp: BinaryIO) -> str: ...


@dataclass(frozen=True)
class DeployConfig:
    host: str
    username: str
    password: str
    source: Path
    remote_dir: str
    port: int = 21
    timeout_seconds: int = 30


def normalize_remote_dir(value: str) -> str:
    normalized = value.strip().replace("\\", "/").strip("/")
    parts = normalized.split("/") if normalized else []
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise ValueError("remote directory must be a non-root path without '.' or '..'")
    return "/".join(parts)


def collect_files(source: Path) -> list[Path]:
    if not source.is_dir():
        raise ValueError(f"site output directory does not exist: {source}")

    files: list[Path] = []
    for candidate in source.rglob("*"):
        if candidate.is_symlink():
            raise ValueError(f"symlinks are not allowed in the deploy artifact: {candidate}")
        if candidate.is_file():
            files.append(candidate)

    if not files:
        raise ValueError(f"site output directory is empty: {source}")

    def upload_order(path: Path) -> tuple[int, str]:
        relative = path.relative_to(source).as_posix()
        if relative == "index.html":
            return (2, relative)
        if path.name == "index.html":
            return (1, relative)
        return (0, relative)

    return sorted(files, key=upload_order)


def ensure_remote_directory(client: FtpsClient, remote_path: str) -> None:
    current = ""
    for part in remote_path.split("/"):
        current = posixpath.join(current, part)
        try:
            client.mkd(current)
        except error_perm as error:
            if not str(error).startswith("550"):
                raise


def deploy_files(client: FtpsClient, source: Path, remote_dir: str) -> int:
    files = collect_files(source)
    ensure_remote_directory(client, remote_dir)
    created_directories = {remote_dir}

    for local_path in files:
        relative = local_path.relative_to(source).as_posix()
        remote_path = posixpath.join(remote_dir, relative)
        parent = posixpath.dirname(remote_path)
        if parent not in created_directories:
            ensure_remote_directory(client, parent)
            created_directories.add(parent)
        with local_path.open("rb") as source_file:
            client.storbinary(f"STOR {remote_path}", source_file)

    return len(files)


def connect_and_deploy(config: DeployConfig) -> int:
    context = ssl.create_default_context()
    client = FTP_TLS(context=context, timeout=config.timeout_seconds)
    try:
        client.connect(config.host, config.port, timeout=config.timeout_seconds)
        client.login(config.username, config.password)
        client.prot_p()
        client.set_pasv(True)
        return deploy_files(client, config.source, config.remote_dir)
    finally:
        try:
            client.quit()
        except all_errors:
            client.close()


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"required environment variable is missing: {name}")
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload the static site to Lolipop over explicit FTPS.")
    parser.add_argument("--source", default="dist/lolipop-site")
    parser.add_argument("--remote-dir", default="bingtangnews")
    parser.add_argument("--check", action="store_true", help="Validate the local artifact without connecting.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = Path(args.source).resolve()
    remote_dir = normalize_remote_dir(args.remote_dir)
    files = collect_files(source)

    if args.check:
        print(f"Lolipop deploy check: {len(files)} files, remote={remote_dir}")
        return 0

    config = DeployConfig(
        host=require_env("LOLIPOP_FTPS_HOST"),
        username=require_env("LOLIPOP_FTPS_USER"),
        password=require_env("LOLIPOP_FTPS_PASSWORD"),
        source=source,
        remote_dir=remote_dir,
        port=int(os.environ.get("LOLIPOP_FTPS_PORT", "21")),
    )

    for attempt in range(1, 4):
        try:
            uploaded = connect_and_deploy(config)
            print(f"Lolipop FTPS deploy complete: {uploaded} files -> {remote_dir}")
            return 0
        except RETRYABLE_ERRORS as error:
            if attempt == 3:
                print(f"Lolipop FTPS deploy failed after {attempt} attempts: {type(error).__name__}", file=sys.stderr)
                return 1
            print(f"Lolipop FTPS attempt {attempt} failed; retrying.", file=sys.stderr)
            time.sleep(attempt * 2)

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
