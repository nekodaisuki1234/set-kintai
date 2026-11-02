#!/usr/bin/env python3
"""Run once in AWS CloudShell using your administrator identity; no access keys required."""
import argparse
import json
from pathlib import Path
import subprocess

SUBJECTS = {
    'repo:nekodaisuki1234/set-kintai:ref:refs/heads/main',
    'repo:nekodaisuki1234@79440835/set-kintai@1414011126:ref:refs/heads/main',
}

def aws(*args):
    result = subprocess.run(['aws', *args, '--output', 'json', '--no-cli-pager'], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--subject', required=True, choices=sorted(SUBJECTS), help='Copy subject from the GitHub OIDC bootstrap identity job')
    args = parser.parse_args()
    identity = aws('sts', 'get-caller-identity')
    account = identity['Account']
    expected = f'arn:aws:iam::{account}:oidc-provider/token.actions.githubusercontent.com'
    providers = aws('iam', 'list-open-id-connect-providers')['OpenIDConnectProviderList']
    existing = any(item['Arn'] == expected for item in providers)
    existing_parameter = expected if existing else ''
    if existing:
        try:
            previous = aws('cloudformation', 'describe-stacks', '--region', 'ap-northeast-1', '--stack-name', 'set-kintai-oidc-development')['Stacks'][0]
        except subprocess.CalledProcessError as error:
            if 'does not exist' not in (error.stderr or ''):
                raise
        else:
            values = {item['ParameterKey']: item['ParameterValue'] for item in previous.get('Parameters', [])}
            if values.get('ExistingOidcProviderArn') == '':
                # Keep a provider created by this stack under the same CloudFormation ownership.
                existing_parameter = ''
    if existing:
        provider = aws('iam', 'get-open-id-connect-provider', '--open-id-connect-provider-arn', expected)
        if provider.get('Url') not in {'token.actions.githubusercontent.com', 'https://token.actions.githubusercontent.com'} or 'sts.amazonaws.com' not in provider.get('ClientIDList', []):
            raise SystemExit('Existing GitHub OIDC provider has an incompatible audience. Review it without replacing shared configuration.')
    template = Path(__file__).resolve().parents[1] / 'backend/infra/github-oidc.yaml'
    print('Creating/updating development OIDC roles and the private artifact bucket in ap-northeast-1. No application database or API is deployed.', flush=True)
    subprocess.run(['aws', 'cloudformation', 'deploy', '--region', 'ap-northeast-1',
                    '--stack-name', 'set-kintai-oidc-development', '--template-file', str(template),
                    '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset',
                    '--parameter-overrides', f'GitHubSubject={args.subject}',
                    f'ExistingOidcProviderArn={existing_parameter}'], check=True)
    stack = aws('cloudformation', 'describe-stacks', '--region', 'ap-northeast-1', '--stack-name', 'set-kintai-oidc-development')['Stacks'][0]
    names = {'AWSAccountId': 'AWS_ACCOUNT_ID', 'AWSDeployRoleArn': 'AWS_DEPLOY_ROLE_ARN',
             'AWSCloudFormationRoleArn': 'AWS_CLOUDFORMATION_ROLE_ARN', 'AWSLambdaRoleArn': 'AWS_LAMBDA_ROLE_ARN', 'AWSArtifactBucket': 'AWS_ARTIFACT_BUCKET'}
    print('\nAdd these nonsecret GitHub Actions Variables:')
    for item in stack['Outputs']:
        if item['OutputKey'] in names:
            print(f'{names[item["OutputKey"]]}={item["OutputValue"]}')

if __name__ == '__main__':
    try:
        main()
    except (KeyError, OSError, ValueError, subprocess.CalledProcessError):
        raise SystemExit('AWS bootstrap did not complete. Check the CloudFormation stack events and your IAM permissions; do not paste credentials into chat.')
