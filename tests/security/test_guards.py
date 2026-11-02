import contextlib
import importlib.util
import io
import os
from pathlib import Path
import secrets
import shutil
import string
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded

security = module('security_check', 'scripts/security/check.py')
deploy = module('aws_deploy', 'scripts/aws-deploy.py')
bootstrap = module('bootstrap_aws', 'scripts/bootstrap-aws.py')

def configuration():
    account = '111122223333'
    return {'AWS_ACCOUNT_ID':account,
            'AWS_DEPLOY_ROLE_ARN':f'arn:aws:iam::{account}:role/set-kintai-development-github',
            'AWS_CLOUDFORMATION_ROLE_ARN':f'arn:aws:iam::{account}:role/set-kintai-development-cloudformation',
            'AWS_LAMBDA_ROLE_ARN':f'arn:aws:iam::{account}:role/set-kintai-development-runtime',
            'AWS_ARTIFACT_BUCKET':f'set-kintai-development-artifacts-{account}-ap-northeast-1',
            'ENTRA_TENANT_ID':'11111111-1111-4111-8111-111111111111',
            'ENTRA_API_AUDIENCE':'22222222-2222-4222-8222-222222222222'}

class DeploymentGuards(unittest.TestCase):
    def test_missing_and_cross_account_config_rejected(self):
        for key in configuration():
            value = configuration(); del value[key]
            with self.subTest(key=key), self.assertRaises(ValueError):
                deploy.configuration(value)
        for key, invalid in [('AWS_ACCOUNT_ID','000000000000'),('AWS_LAMBDA_ROLE_ARN','arn:aws:iam::999988887777:role/set-kintai-development-runtime'),
                             ('ENTRA_TENANT_ID','common'),('ENTRA_API_AUDIENCE','https://graph.microsoft.com'),
                             ('ENTRA_REQUIRED_SCOPE','read write'),('TEMPLATE_KEY','templates/../../private.xlsm'),
                             ('TEMPLATE_KEY','templates/test.xlsm')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                deploy.configuration({**configuration(),key:invalid})

    def test_no_shell_and_no_secrets_in_deployment_command(self):
        env = configuration()
        args = deploy.deploy_arguments(env)
        self.assertEqual(args[:2],['sam','deploy'])
        self.assertIn('set-kintai-development',args)
        self.assertIn('ParameterKey=TemplateKey,ParameterValue=""',args)
        self.assertIn('ParameterKey=Stage,ParameterValue="development"',args)
        self.assertNotIn('CAPABILITY_IAM',args)
        self.assertFalse(any('secret' in value.lower() or 'password' in value.lower() for value in args))

    def test_check_mode_never_calls_aws(self):
        with patch.dict(os.environ,configuration(),clear=True), patch('sys.argv',['aws-deploy.py']), patch.object(subprocess,'run') as run, contextlib.redirect_stdout(io.StringIO()):
            deploy.main();run.assert_not_called()

    def test_wrong_branch_or_runtime_identity_never_deploys(self):
        env = {**configuration(),'GITHUB_REPOSITORY_ID':'1414011126','GITHUB_REF':'refs/pull/10/merge'}
        with patch.dict(os.environ,env,clear=True), patch('sys.argv',['aws-deploy.py','--deploy']), patch.object(subprocess,'run') as run:
            with self.assertRaises(ValueError): deploy.main()
            run.assert_not_called()
        env['GITHUB_REF']='refs/heads/main'
        response = subprocess.CompletedProcess([],0,'{"Account":"111122223333","Arn":"arn:aws:iam::111122223333:user/admin"}')
        with patch.dict(os.environ,env,clear=True), patch('sys.argv',['aws-deploy.py','--deploy']), patch.object(subprocess,'run',return_value=response) as run:
            with self.assertRaises(ValueError): deploy.main()
            self.assertEqual(run.call_count,1)

    def test_bootstrap_reuses_shared_provider_without_mutating_it(self):
        arn='arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
        answers=[{'Account':'111122223333'},{'OpenIDConnectProviderList':[{'Arn':arn}]},
                 {'Stacks':[{'Parameters':[{'ParameterKey':'ExistingOidcProviderArn','ParameterValue':arn}]}]},
                 {'Url':'token.actions.githubusercontent.com','ClientIDList':['sts.amazonaws.com']},
                 {'Stacks':[{'Outputs':[]}]}]
        with patch.object(bootstrap,'aws',side_effect=answers) as query, patch.object(subprocess,'run') as mutate, patch('sys.argv',['bootstrap-aws.py','--subject',sorted(bootstrap.SUBJECTS)[0]]), contextlib.redirect_stdout(io.StringIO()):
            bootstrap.main()
            mutate.assert_called_once()
            self.assertIn('ExistingOidcProviderArn='+arn,mutate.call_args.args[0])
            self.assertFalse(any('delete-open-id-connect-provider' in str(call) for call in query.call_args_list))

    def test_bootstrap_keeps_ownership_of_its_provider_on_rerun(self):
        arn='arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
        answers=[{'Account':'111122223333'},{'OpenIDConnectProviderList':[{'Arn':arn}]},
                 {'Stacks':[{'Parameters':[{'ParameterKey':'ExistingOidcProviderArn','ParameterValue':''}]}]},
                 {'Url':'token.actions.githubusercontent.com','ClientIDList':['sts.amazonaws.com']},
                 {'Stacks':[{'Outputs':[]}]}]
        with patch.object(bootstrap,'aws',side_effect=answers), patch.object(subprocess,'run') as mutate, patch('sys.argv',['bootstrap-aws.py','--subject',sorted(bootstrap.SUBJECTS)[0]]), contextlib.redirect_stdout(io.StringIO()):
            bootstrap.main()
            self.assertIn('ExistingOidcProviderArn=',mutate.call_args.args[0])

    def test_incompatible_shared_provider_stops_before_mutation(self):
        arn='arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
        answers=[{'Account':'111122223333'},{'OpenIDConnectProviderList':[{'Arn':arn}]},
                 {'Stacks':[{'Parameters':[{'ParameterKey':'ExistingOidcProviderArn','ParameterValue':arn}]}]},
                 {'Url':'token.actions.githubusercontent.com','ClientIDList':['different-audience']}]
        with patch.object(bootstrap,'aws',side_effect=answers), patch.object(subprocess,'run') as mutate, patch('sys.argv',['bootstrap-aws.py','--subject',sorted(bootstrap.SUBJECTS)[0]]):
            with self.assertRaises(SystemExit): bootstrap.main()
            mutate.assert_not_called()

class SecretGuards(unittest.TestCase):
    def test_private_names_and_public_code(self):
        for name in ['.env','.env.production','backend/.env','private/profile.json','x/credentials','profile.person.json','data/report.XLSM','exports/record.json','real.csv','key.PEM','samconfig.toml']:
            self.assertTrue(security.private_path(name),name)
        for name in ['.env.example','backend/package.json','backend/examples/template-mapping.example.json','day-designs/paper-config.js','backend/src/export-format.cjs']:
            self.assertFalse(security.private_path(name),name)

    def repository(self, directory):
        def git(*args):
            return subprocess.run(['git','-C',directory,*args],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        git('init','-q');git('config','user.name','Security test');git('config','user.email','test@example.invalid')
        Path(directory,'README.md').write_text('Synthetic scanner fixture\n')
        git('add','README.md');git('commit','-qm','initial')
        return git

    def test_force_added_private_file_is_rejected_without_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            git=self.repository(directory)
            Path(directory,'.env').write_text('PRIVATE_SENTINEL=do-not-print-this\n')
            git('add','.env')
            result=subprocess.run(['python3',str(ROOT/'scripts/security/check.py'),'--staged','--files-only'],cwd=directory,capture_output=True,text=True)
            self.assertEqual(result.returncode,1)
            self.assertNotIn('do-not-print-this',result.stdout+result.stderr)

    def test_actual_scanner_rejects_staged_and_deleted_historical_secret_without_logging_value(self):
        self.assertIsNotNone(shutil.which('gitleaks'),'Install the pinned scanner before running security tests')
        with tempfile.TemporaryDirectory() as directory:
            git=self.repository(directory)
            fake='gh'+'p_'+''.join(secrets.choice(string.ascii_letters+string.digits) for _ in range(36))
            Path(directory,'example.js').write_text('const token = "'+fake+'";\n')
            git('add','example.js')
            args=['python3',str(ROOT/'scripts/security/check.py')]
            result=subprocess.run([*args,'--staged'],cwd=directory,capture_output=True,text=True)
            self.assertEqual(result.returncode,1,result.stdout)
            self.assertNotIn(fake,result.stdout+result.stderr)
            git('commit','-qm','synthetic secret');git('rm','example.js');git('commit','-qm','remove synthetic secret')
            result=subprocess.run(args,cwd=directory,capture_output=True,text=True)
            self.assertEqual(result.returncode,1,result.stdout)
            self.assertNotIn(fake,result.stdout+result.stderr)

if __name__=='__main__': unittest.main()
