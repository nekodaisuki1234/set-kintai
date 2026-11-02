#!/usr/bin/env python3
"""Deploy a committed local Git revision directly to AWS with a selected SSO profile."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
STACK = 'set-kintai-development'
REGION = 'ap-northeast-1'
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
REQUIRED = ['AWS_ACCOUNT_ID', 'AWS_CLOUDFORMATION_ROLE_ARN', 'AWS_LAMBDA_ROLE_ARN',
            'AWS_ARTIFACT_BUCKET', 'ENTRA_TENANT_ID', 'ENTRA_API_AUDIENCE']
OPTIONAL = ['ENTRA_REQUIRED_SCOPE', 'TEMPLATE_KEY', 'TEMPLATE_MAPPING_KEY']

def configuration(values):
    if not isinstance(values, dict) or set(values) - set(REQUIRED + OPTIONAL):
        raise ValueError('The config must contain only the documented nonsecret deployment settings.')
    if any(not isinstance(value, str) for value in values.values()):
        raise ValueError('Deployment settings must be strings.')
    missing = [key for key in REQUIRED if not values.get(key)]
    if missing:
        raise ValueError('Complete deploy.local.json: ' + ', '.join(missing))
    account = values['AWS_ACCOUNT_ID']
    if not re.fullmatch(r'[0-9]{12}', account) or account == '000000000000':
        raise ValueError('AWS_ACCOUNT_ID must be the actual target account ID.')
    for key, suffix in [('AWS_CLOUDFORMATION_ROLE_ARN', 'cloudformation'), ('AWS_LAMBDA_ROLE_ARN', 'runtime')]:
        if values[key] != f'arn:aws:iam::{account}:role/{STACK}-{suffix}':
            raise ValueError(key + ' must match the bootstrap role in the target account.')
    if values['AWS_ARTIFACT_BUCKET'] != f'{STACK}-artifacts-{account}-{REGION}':
        raise ValueError('AWS_ARTIFACT_BUCKET must match the private bootstrap bucket.')
    for key in ['ENTRA_TENANT_ID', 'ENTRA_API_AUDIENCE']:
        if not re.fullmatch(UUID, values[key]) or values[key] == '00000000-0000-0000-0000-000000000000':
            raise ValueError(key + ' must be the actual lowercase Microsoft UUID (v2 API audience).')
    scope = values.get('ENTRA_REQUIRED_SCOPE') or 'access_as_user'
    if not re.fullmatch(r'[A-Za-z0-9_.:/-]{1,128}', scope):
        raise ValueError('ENTRA_REQUIRED_SCOPE must be one delegated scope, without whitespace.')
    parameters = {'Stage': 'development', 'LambdaExecutionRoleArn': values['AWS_LAMBDA_ROLE_ARN'],
                  'EntraTenantId': values['ENTRA_TENANT_ID'], 'EntraApiAudience': values['ENTRA_API_AUDIENCE'],
                  'EntraRequiredScope': scope, 'AllowedOrigin': 'https://nekodaisuki1234.github.io'}
    for key, parameter in [('TEMPLATE_KEY', 'TemplateKey'), ('TEMPLATE_MAPPING_KEY', 'TemplateMappingKey')]:
        value = values.get(key, '')
        if value and (not re.fullmatch(r'templates/[A-Za-z0-9][A-Za-z0-9._/-]{0,200}', value) or '..' in value.split('/')):
            raise ValueError(key + ' must be a private templates/ object key.')
        parameters[parameter] = value
    if bool(parameters['TemplateKey']) != bool(parameters['TemplateMappingKey']):
        raise ValueError('Configure both template keys, or leave both empty to disable Excel export.')
    return parameters

def deploy_arguments(values, profile):
    parameters = configuration(values)
    if not profile or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', profile):
        raise ValueError('Choose a local AWS SSO profile with --profile.')
    return ['sam', 'deploy', '--profile', profile, '--template-file', '.aws-sam/build/template.yaml', '--region', REGION,
            '--stack-name', STACK, '--s3-bucket', values['AWS_ARTIFACT_BUCKET'], '--s3-prefix', 'application',
            '--role-arn', values['AWS_CLOUDFORMATION_ROLE_ARN'], '--capabilities', 'CAPABILITY_AUTO_EXPAND',
            '--no-confirm-changeset', '--no-fail-on-empty-changeset', '--parameter-overrides',
            *[f'ParameterKey={key},ParameterValue="{value}"' for key, value in parameters.items()]]

def validate_identity(identity, account):
    prefix = f'arn:aws:sts::{account}:assumed-role/'
    if identity.get('Account') != account or not identity.get('Arn', '').startswith(prefix):
        raise ValueError('Use a temporary assumed-role session in the configured AWS account (SSO), not an IAM user/root access key.')

def local_checks():
    dirty = subprocess.run(['git', 'status', '--porcelain', '--untracked-files=normal'], check=True, capture_output=True, text=True)
    if dirty.stdout.strip():
        raise ValueError('Commit the local code before deployment; local config/build artifacts are ignored by Git.')
    commands = [
        ['python3', 'scripts/security/check.py'],
        ['python3', '-m', 'unittest', 'discover', '-s', 'tests/security', '-p', 'test_*.py'],
        ['npm', 'ci', '--prefix', 'backend', '--ignore-scripts'],
        ['npm', 'audit', '--prefix', 'backend', '--omit=dev', '--audit-level=moderate'],
        ['npm', 'test', '--prefix', 'backend'],
        ['sam', 'validate', '--lint', '--template-file', 'backend/infra/deployment-bootstrap.yaml', '--region', REGION],
        ['sam', 'validate', '--lint', '--template-file', 'backend/infra/template.yaml', '--region', REGION],
        ['sam', 'build', '--template-file', 'backend/infra/template.yaml'],
    ]
    for command in commands:
        subprocess.run(command, check=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('deploy.local.json'))
    parser.add_argument('--profile', help='Named AWS CLI SSO profile for the development account')
    parser.add_argument('--deploy', action='store_true')
    args = parser.parse_args()
    values = json.loads(args.config.read_text())
    configuration(values)
    if not args.deploy:
        print('PASS local deployment configuration; no AWS connection attempted.')
        return
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        raise ValueError('Deployment is local-only; GitHub Actions is not an allowed deployment source.')
    command = deploy_arguments(values, args.profile)
    os.chdir(ROOT)
    local_checks()
    identity = subprocess.run(['aws', '--profile', args.profile, 'sts', 'get-caller-identity', '--output', 'json'],
                              check=True, capture_output=True, text=True)
    validate_identity(json.loads(identity.stdout), values['AWS_ACCOUNT_ID'])
    subprocess.run(command, check=True)

if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error))
    except FileNotFoundError:
        raise SystemExit('Create deploy.local.json from backend/examples/deploy.example.json and install the documented local tools.')
    except (subprocess.CalledProcessError, OSError):
        raise SystemExit('Local validation or AWS operation failed; review the preceding step without printing credentials.')
