from __future__ import annotations

from dataclasses import dataclass
from importlib import metadata
import json
from pathlib import Path
import subprocess
from urllib.parse import unquote, urlparse

import ctor


@dataclass(frozen=True)
class ContinuatorRuntimeInfo:
    version: str | None
    package_version: str | None
    commit: str | None
    source_url: str | None

    def model_dump(self) -> dict[str, str | None]:
        return {
            "version": self.version,
            "package_version": self.package_version,
            "commit": self.commit,
            "source_url": self.source_url,
        }


def _continuator_distribution() -> metadata.Distribution | None:
    try:
        return metadata.distribution("continuator")
    except metadata.PackageNotFoundError:
        return None


def _direct_url_info(
    distribution: metadata.Distribution | None,
) -> tuple[str | None, str | None]:
    if distribution is None:
        return None, None
    try:
        raw_payload = distribution.read_text("direct_url.json")
    except FileNotFoundError:
        return None, None
    if not raw_payload:
        return None, None

    try:
        payload = json.loads(raw_payload)
    except json.JSONDecodeError:
        return None, None

    source_url = payload.get("url")
    vcs_info = payload.get("vcs_info") or {}
    commit = vcs_info.get("commit_id") or vcs_info.get("requested_revision")
    return (
        str(source_url) if source_url else None,
        str(commit) if commit else None,
    )


def _path_from_file_url(url: str | None) -> Path | None:
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme != "file":
        return None
    return Path(unquote(parsed.path))


def _git_commit_from_path(path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        result = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    commit = result.stdout.strip()
    return commit or None


def continuator_runtime_info() -> ContinuatorRuntimeInfo:
    distribution = _continuator_distribution()
    package_version = distribution.version if distribution is not None else None
    runtime_version = getattr(ctor, "__version__", None) or package_version
    source_url, commit = _direct_url_info(distribution)
    if commit is None:
        commit = _git_commit_from_path(_path_from_file_url(source_url))
    if commit is None:
        ctor_file = getattr(ctor, "__file__", None)
        if ctor_file:
            commit = _git_commit_from_path(Path(ctor_file).resolve().parent)
    public_source_url = (
        None if urlparse(source_url or "").scheme == "file" else source_url
    )
    return ContinuatorRuntimeInfo(
        version=str(runtime_version) if runtime_version else None,
        package_version=str(package_version) if package_version else None,
        commit=commit,
        source_url=public_source_url,
    )
