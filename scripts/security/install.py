#!/usr/bin/env python3
"""Install the reviewed Gitleaks binary; verify bytes before extracting/executing."""
import argparse
import hashlib
import io
from pathlib import Path
import platform
import tarfile
import urllib.request

VERSION = '8.30.1'
DIGESTS = {
    ('linux', 'x64'): '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
    ('linux', 'arm64'): 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
    ('darwin', 'x64'): 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
    ('darwin', 'arm64'): 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    system = platform.system().lower()
    arch = {'x86_64': 'x64', 'amd64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine().lower())
    digest = DIGESTS.get((system, arch))
    if not digest:
        parser.error('Supported: Linux/macOS x64 or arm64; use WSL on Windows.')
    asset = f'gitleaks_{VERSION}_{system}_{arch}.tar.gz'
    url = f'https://github.com/gitleaks/gitleaks/releases/download/v{VERSION}/{asset}'
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(30 * 1024 * 1024 + 1)
    if len(data) > 30 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != digest:
        raise SystemExit('Gitleaks download checksum mismatch; nothing installed.')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        member = archive.getmember('gitleaks')
        if not member.isfile() or member.size > 100 * 1024 * 1024:
            raise SystemExit('Unexpected Gitleaks archive.')
        args.destination.mkdir(parents=True, exist_ok=True)
        target = args.destination / 'gitleaks'
        target.write_bytes(archive.extractfile(member).read())
        target.chmod(0o755)
    print(f'Gitleaks {VERSION}: checksum verified; installed {target}')

if __name__ == '__main__':
    main()
