#!/usr/bin/env python3
"""Reject private files and scan Git history/staged changes without logging secret values."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile

PRIVATE_DIRS = {'.aws', '.secrets', 'secrets', 'private', 'attachments', 'exports'}
PRIVATE_SUFFIXES = {'.pem', '.key', '.p12', '.pfx', '.jks', '.xls', '.xlsx', '.xlsm', '.csv'}

def private_path(name):
    path = PurePosixPath(name.lower())
    base = path.name
    return (bool(PRIVATE_DIRS.intersection(path.parts)) or path.suffix in PRIVATE_SUFFIXES
            or (base == '.env' or base.startswith('.env.')) and base != '.env.example'
            or base in {'credentials', 'credentials.json', 'samconfig.toml', 'samconfig.yaml', 'profile.json'}
            or re.fullmatch(r'profile\..*\.json', base) is not None
            or base.endswith(('.local.json', '.local.toml')))

def git(*args):
    return subprocess.run(['git', *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staged', action='store_true')
    parser.add_argument('--files-only', action='store_true', help='Only check filenames; not a replacement for secret scanning')
    args = parser.parse_args()
    root = Path(git('rev-parse', '--show-toplevel').decode().strip())
    os.chdir(root)
    # CI checks the entire tracked tree, even files force-added despite .gitignore.
    listing = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z') if args.staged else git('ls-files', '-z')
    blocked = [name for name in listing.decode('utf-8', errors='surrogateescape').split('\0') if name and private_path(name)]
    if blocked:
        for name in blocked:
            print('Private file rejected: ' + json.dumps(name, ensure_ascii=True))
        return 1
    if args.files_only:
        print('PASS tracked private-file check (secret scanner not run)')
        return 0
    binary = shutil.which('gitleaks')
    if not binary:
        print('Gitleaks is required. Follow backend/docs/aws-deployment.md to install and enable the hook.')
        return 2
    version = subprocess.run([binary, 'version'], capture_output=True, text=True)
    if version.returncode or version.stdout.strip().lstrip('v') != '8.30.1':
        print('Gitleaks 8.30.1 is required; reinstall the pinned binary.')
        return 2
    with tempfile.TemporaryDirectory(prefix='set-kintai-secret-check-') as directory:
        report = Path(directory, 'findings.json')
        config = Path(directory, 'scanner.toml')
        config.write_text('[extend]\nuseDefault = true\n')
        ignored = Path(directory, 'empty-ignore')
        ignored.write_text('')
        # Ignore inline bypass comments; no baseline or broad fixture exclusions.
        command = [binary, 'git', '--redact=100', '--no-banner', '--ignore-gitleaks-allow',
                   '--report-format=json', '--report-path=' + str(report),
                   '--config=' + str(config), '--gitleaks-ignore-path=' + str(ignored)]
        command += ['--staged'] if args.staged else ['--log-opts=--all']
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode == 0:
            print('PASS private-file check and Gitleaks ' + ('staged changes' if args.staged else 'available Git history'))
            return 0
        if result.returncode != 1 or not report.exists():
            print('Secret scanner failed; check tool installation and repository access. Raw scanner output suppressed.')
            return 2
        findings = json.loads(report.read_text())
        for finding in findings:
            # Never print Match, Secret, author/email, or source lines.
            print('Secret candidate: ' + json.dumps({
                'file': finding.get('File'), 'line': finding.get('StartLine'),
                'rule': finding.get('RuleID'), 'commit': finding.get('Commit', '')[:12],
            }, ensure_ascii=True))
        print(f'FAIL {len(findings)} secret candidate(s). Remove from new commits; revoke/rotate any real exposed credential.')
        return 1

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.CalledProcessError):
        raise SystemExit('Security check could not complete; raw output suppressed.')
