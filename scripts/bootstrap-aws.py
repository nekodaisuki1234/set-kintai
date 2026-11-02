#!/usr/bin/env python3
"""Provision AWS-local deployment permissions; no GitHub identity or access key is created."""
import argparse
import json
from pathlib import Path
import subprocess

STACK = 'set-kintai-deployment-development'
REGION = 'ap-northeast-1'

def command(profile, *args):
    return ['aws', *(['--profile', profile] if profile else []), *args]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', help='Local administrator SSO profile; omit only when using CloudShell console credentials')
    args = parser.parse_args()
    template = Path(__file__).resolve().parents[1] / 'backend/infra/deployment-bootstrap.yaml'
    print('Creating/updating AWS-local deployment permissions and a private artifact bucket. No application API/database or external identity trust is created.', flush=True)
    subprocess.run(command(args.profile, 'cloudformation', 'deploy', '--region', REGION,
                           '--stack-name', STACK, '--template-file', str(template),
                           '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset'), check=True)
    result = subprocess.run(command(args.profile, 'cloudformation', 'describe-stacks', '--region', REGION,
                                    '--stack-name', STACK, '--output', 'json', '--no-cli-pager'),
                            check=True, capture_output=True, text=True)
    stack = json.loads(result.stdout)['Stacks'][0]
    names = {'AWSAccountId': 'AWS_ACCOUNT_ID', 'AWSCloudFormationRoleArn': 'AWS_CLOUDFORMATION_ROLE_ARN',
             'AWSLambdaRoleArn': 'AWS_LAMBDA_ROLE_ARN', 'AWSArtifactBucket': 'AWS_ARTIFACT_BUCKET'}
    values = {}
    for item in stack['Outputs']:
        if item['OutputKey'] in names:
            values[names[item['OutputKey']]] = item['OutputValue']
        elif item['OutputKey'] == 'LocalDeploymentPolicyArn':
            print('Attach this policy to the developer permission set: ' + item['OutputValue'])
    print('Copy these nonsecret settings into deploy.local.json:')
    print(json.dumps(values, indent=2))

if __name__ == '__main__':
    try:
        main()
    except (KeyError, OSError, ValueError, subprocess.CalledProcessError):
        raise SystemExit('AWS bootstrap did not complete. Check CloudFormation events and your IAM permissions; do not paste credentials into chat.')
