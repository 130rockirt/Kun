from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

from pydantic import BaseModel

from .artifacts import sha256_file
from .config import ModelSettings, RunOptions
from .constants import MIN_FREE_DISK_BYTES, REQUIRED_MODEL_ENV


class Blocker(BaseModel):
    code: str
    message: str
    deferred: bool = False


class PreflightReport(BaseModel):
    ok: bool
    dry_run: bool
    blockers: list[Blocker]
    checks: dict[str, object]


def run_preflight(
    options: RunOptions,
    *,
    env: dict[str, str],
    repository_root: Path,
) -> PreflightReport:
    blockers: list[Blocker] = []
    checks: dict[str, object] = {}
    uv_path = shutil.which("uv")
    checks["uv"] = uv_path
    if not uv_path:
        blockers.append(
            Blocker(
                code="uv_missing",
                message="Install uv before running benchmarks",
                deferred=options.dry_run,
            )
        )

    free_bytes = shutil.disk_usage(repository_root).free
    checks["free_disk_bytes"] = free_bytes
    if free_bytes < MIN_FREE_DISK_BYTES:
        blockers.append(
            Blocker(
                code="disk_space",
                message=(
                    f"At least {MIN_FREE_DISK_BYTES} free bytes are required; found {free_bytes}"
                ),
                deferred=options.dry_run,
            )
        )

    docker_ok, docker_message = docker_available()
    checks["docker"] = docker_message
    if not docker_ok:
        blockers.append(
            Blocker(
                code="docker_unavailable",
                message=docker_message,
                deferred=options.dry_run,
            )
        )

    missing = [name for name in REQUIRED_MODEL_ENV if not env.get(name, "").strip()]
    checks["model_environment"] = "configured" if not missing else {"missing": missing}
    if missing:
        blockers.append(
            Blocker(
                code="model_environment",
                message=f"Missing required environment variables: {', '.join(missing)}",
                deferred=options.dry_run,
            )
        )
    else:
        try:
            ModelSettings.from_environment(env)
        except ValueError as exc:
            blockers.append(
                Blocker(
                    code="model_environment_invalid", message=str(exc), deferred=options.dry_run
                )
            )

    if options.kun_archive:
        archive = options.kun_archive
        if not archive.is_file():
            blockers.append(
                Blocker(code="archive_missing", message=f"Archive not found: {archive}")
            )
        else:
            checks["kun_archive_sha256"] = sha256_file(archive)

    fatal = [blocker for blocker in blockers if not blocker.deferred]
    return PreflightReport(ok=not fatal, dry_run=options.dry_run, blockers=blockers, checks=checks)


def docker_available() -> tuple[bool, str]:
    if not shutil.which("docker"):
        return False, "Docker CLI is not installed"
    try:
        result = subprocess.run(
            ["docker", "info", "--format", "{{json .ServerVersion}}"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"Docker check failed: {exc}"
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "daemon is unavailable"
        return False, f"Docker daemon is unavailable: {detail}"
    if not result.stdout.strip() or result.stdout.strip() in {'""', "null"}:
        return False, "Docker daemon is unavailable: server version was not reported"
    try:
        version = json.loads(result.stdout)
    except json.JSONDecodeError:
        version = result.stdout.strip()
    if not version:
        return False, "Docker daemon is unavailable: server version was empty"
    return True, f"Docker server {version}"
