#!/usr/bin/env python3
"""Validate nonsecret GitHub Variables, then deploy only the development application."""
import argparse
import json
import os
import re
import subprocess

STACK = 'set-kintai-development'
REGION = 'ap-northeast-1'
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

def configuration(env):
    required = ['AWS_ACCOUNT_ID', 'AWS_DEPLOY_ROLE_ARN', 'AWS_CLOUDFORMATION_ROLE_ARN',
                'AWS_LAMBDA_ROLE_ARN', 'AWS_ARTIFACT_BUCKET', 'ENTRA_TENANT_ID', 'ENTRA_API_AUDIENCE']
    missing = [key for key in required if not env.get(key)]
    if missing:
        raise ValueError('Set GitHub Actions Variables: ' + ', '.join(missing))
    account = env['AWS_ACCOUNT_ID']
    if not re.fullmatch(r'[0-9]{12}', account) or account == '000000000000':
        raise ValueError('AWS_ACCOUNT_ID must be the actual target account ID.')
    for key, suffix in [('AWS_DEPLOY_ROLE_ARN', 'github'), ('AWS_CLOUDFORMATION_ROLE_ARN', 'cloudformation'), ('AWS_LAMBDA_ROLE_ARN', 'runtime')]:
        if env[key] != f'arn:aws:iam::{account}:role/{STACK}-{suffix}':
            raise ValueError(key + ' must match the bootstrap role in the target account.')
    if env['AWS_ARTIFACT_BUCKET'] != f'{STACK}-artifacts-{account}-{REGION}':
        raise ValueError('AWS_ARTIFACT_BUCKET must match the private bootstrap bucket.')
    for key in ['ENTRA_TENANT_ID', 'ENTRA_API_AUDIENCE']:
        if not re.fullmatch(UUID, env[key]) or env[key] == '00000000-0000-0000-0000-000000000000':
            raise ValueError(key + ' must be the actual lowercase Microsoft UUID (v2 API audience).')
    scope = env.get('ENTRA_REQUIRED_SCOPE') or 'access_as_user'
    if not re.fullmatch(r'[A-Za-z0-9_.:/-]{1,128}', scope):
        raise ValueError('ENTRA_REQUIRED_SCOPE must be one delegated scope, without whitespace.')
    parameters = {'Stage': 'development', 'LambdaExecutionRoleArn': env['AWS_LAMBDA_ROLE_ARN'],
                  'EntraTenantId': env['ENTRA_TENANT_ID'], 'EntraApiAudience': env['ENTRA_API_AUDIENCE'],
                  'EntraRequiredScope': scope, 'AllowedOrigin': 'https://nekodaisuki1234.github.io'}
    for key, parameter in [('TEMPLATE_KEY', 'TemplateKey'), ('TEMPLATE_MAPPING_KEY', 'TemplateMappingKey')]:
        value = env.get(key, '')
        if value and (not re.fullmatch(r'templates/[A-Za-z0-9][A-Za-z0-9._/-]{0,200}', value) or '..' in value.split('/')):
            raise ValueError(key + ' must be a private templates/ object key.')
        parameters[parameter] = value
    if bool(parameters['TemplateKey']) != bool(parameters['TemplateMappingKey']):
        raise ValueError('Configure both template keys, or leave both empty to disable Excel export.')
    return parameters

def deploy_arguments(env):
    parameters = configuration(env)
    return ['sam', 'deploy', '--template-file', '.aws-sam/build/template.yaml', '--region', REGION,
            '--stack-name', STACK, '--s3-bucket', env['AWS_ARTIFACT_BUCKET'], '--s3-prefix', 'application',
            '--role-arn', env['AWS_CLOUDFORMATION_ROLE_ARN'], '--capabilities', 'CAPABILITY_AUTO_EXPAND',
            '--no-confirm-changeset', '--no-fail-on-empty-changeset', '--parameter-overrides',
            *[f'ParameterKey={key},ParameterValue="{value}"' for key, value in parameters.items()]]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deploy', action='store_true')
    args = parser.parse_args()
    configuration(os.environ)
    if not args.deploy:
        print('PASS development deployment configuration; no AWS connection attempted.')
        return
    if os.environ.get('GITHUB_REPOSITORY_ID') != '1414011126' or os.environ.get('GITHUB_REF') != 'refs/heads/main':
        raise ValueError('Deploy through the main-branch GitHub workflow only.')
    identity = subprocess.run(['aws', 'sts', 'get-caller-identity', '--output', 'json'], check=True, capture_output=True, text=True)
    identity = json.loads(identity.stdout)
    prefix = f'arn:aws:sts::{os.environ["AWS_ACCOUNT_ID"]}:assumed-role/{STACK}-github/'
    if identity.get('Account') != os.environ['AWS_ACCOUNT_ID'] or not identity.get('Arn', '').startswith(prefix):
        raise ValueError('AWS assumed identity does not match the configured development role.')
    subprocess.run(deploy_arguments(os.environ), check=True)

if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error))
    except (subprocess.CalledProcessError, OSError, json.JSONDecodeError):
        raise SystemExit('AWS/SAM operation failed; review the deployment step without printing credentials.')
