#!/usr/bin/env python3
"""Build a deterministic, unpacked-installable Chrome extension release."""

import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
import zipfile


RELEASE_FILES = (
    "background.js",
    "content.js",
    "github.js",
    "manifest.json",
    "options.html",
    "options.js",
    "protocol.js",
    "sandbox.css",
    "sandbox.html",
    "sandbox.js",
    "viewer.css",
    "viewer.html",
    "viewer.js",
)
VERSION_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
INSTALL_TEXT = """Plannotate 安装说明

1. 解压 ZIP（若使用本目录则跳过）。
2. 在 Ego Lite 或 Chromium 浏览器打开 chrome://extensions/。
3. 打开右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」。
5. 选择包含 manifest.json 的 plannotate-v{version} 目录。
6. 打开扩展的「详细信息」→「扩展程序选项」，点击已预填权限的 GitHub 创建链接。
7. 选择正确的 Resource owner 和目标仓库，生成 token 后粘贴并点击「保存并检查」。

Token 最小仓库权限：Contents read、Pull requests read/write、Metadata read。
如果 plan 能读取但评论报 403，请把 Pull requests 从 Read-only 改为 Read and write；
组织仓库还可能需要管理员批准或 SSO 授权。
随后打开 GitHub PR，选择 PR 导航中的 Plan review。
"""


class BuildError(RuntimeError):
    """Raised when extension sources do not form a valid release."""


def _repository_root():
    return os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


def _manifest(extension_directory):
    path = os.path.join(extension_directory, "manifest.json")
    with open(path, "r", encoding="utf-8") as source:
        manifest = json.load(source)
    version = manifest.get("version")
    if manifest.get("manifest_version") != 3:
        raise BuildError("extension must use Manifest V3")
    if not isinstance(version, str) or VERSION_PATTERN.fullmatch(version) is None:
        raise BuildError("manifest version must be numeric x.y.z")
    return manifest


def _read_release_files(extension_directory):
    missing = [
        name for name in RELEASE_FILES
        if not os.path.isfile(os.path.join(extension_directory, name))
    ]
    if missing:
        raise BuildError("missing release files: " + ", ".join(missing))
    return {
        name: _read_bytes(os.path.join(extension_directory, name))
        for name in RELEASE_FILES
    }


def _read_bytes(path):
    with open(path, "rb") as source:
        return source.read()


def _write_directory(path, files, version):
    os.makedirs(path)
    for name, body in files.items():
        destination = os.path.join(path, name)
        with open(destination, "wb") as target:
            target.write(body)
    install = INSTALL_TEXT.format(version=version).encode("utf-8")
    with open(os.path.join(path, "INSTALL.txt"), "wb") as target:
        target.write(install)


def _zip_directory(directory, destination):
    root_name = os.path.basename(directory)
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(os.listdir(directory)):
            path = os.path.join(directory, name)
            info = zipfile.ZipInfo(root_name + "/" + name, ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, _read_bytes(path), compress_type=zipfile.ZIP_DEFLATED)


def _replace_file(source, destination):
    if os.path.exists(destination):
        os.unlink(destination)
    os.replace(source, destination)


def _replace_directory(source, destination):
    if os.path.exists(destination):
        shutil.rmtree(destination)
    os.replace(source, destination)


def build(output_directory=None):
    root = _repository_root()
    extension_directory = os.path.join(root, "extension")
    output_directory = os.path.realpath(
        output_directory or os.path.join(root, "dist")
    )
    manifest = _manifest(extension_directory)
    version = manifest["version"]
    release_name = "plannotate-v" + version
    files = _read_release_files(extension_directory)
    os.makedirs(output_directory, exist_ok=True)
    temporary = tempfile.mkdtemp(prefix=".extension-build-", dir=output_directory)
    try:
        staged_directory = os.path.join(temporary, release_name)
        staged_zip = os.path.join(temporary, release_name + ".zip")
        _write_directory(staged_directory, files, version)
        _zip_directory(staged_directory, staged_zip)
        final_directory = os.path.join(output_directory, release_name)
        final_zip = os.path.join(output_directory, release_name + ".zip")
        _replace_directory(staged_directory, final_directory)
        _replace_file(staged_zip, final_zip)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
    digest = hashlib.sha256(_read_bytes(final_zip)).hexdigest()
    checksum_path = os.path.join(output_directory, "SHA256SUMS.txt")
    with open(checksum_path, "w", encoding="ascii") as destination:
        destination.write("{0}  {1}.zip\n".format(digest, release_name))
    return {
        "directory": final_directory,
        "zip": final_zip,
        "checksum": checksum_path,
        "sha256": digest,
        "version": version,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", help="release output directory")
    args = parser.parse_args(argv)
    result = build(args.output)
    print("directory: " + result["directory"])
    print("zip: " + result["zip"])
    print("sha256: " + result["sha256"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
