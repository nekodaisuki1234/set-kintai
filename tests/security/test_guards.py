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
            'AWS_CLOUDFORMATION_ROLE_ARN':f'arn:aws:iam::{account}:role/set-kintai-development-cloudformation',
            'AWS_LAMBDA_ROLE_ARN':f'arn:aws:iam::{account}:role/set-kintai-development-runtime',
            'AWS_ARTIFACT_BUCKET':f'set-kintai-development-artifacts-{account}-ap-northeast-1',
            'ENTRA_TENANT_ID':'11111111-1111-4111-8111-111111111111',
            'ENTRA_API_AUDIENCE':'22222222-2222-4222-8222-222222222222'}

class DeploymentGuards(unittest.TestCase):
    def test_missing_and_cross_account_config_rejected(self):
        for key in configuration():
            value = configuration(); del value[key]
            with self.subTest(key=key), self.assertRaises(ValueError): deploy.configuration(value)
        for key, invalid in [('AWS_ACCOUNT_ID','000000000000'),('AWS_LAMBDA_ROLE_ARN','arn:aws:iam::999988887777:role/set-kintai-development-runtime'),
                             ('ENTRA_TENANT_ID','common'),('ENTRA_API_AUDIENCE','https://graph.microsoft.com'),
                             ('ENTRA_REQUIRED_SCOPE','read write'),('TEMPLATE_KEY','templates/../../private.xlsm'),
                             ('TEMPLATE_KEY','templates/test.xlsm'),('AWS_SECRET_ACCESS_KEY','must-not-be-accepted')]:
            with self.subTest(key=key), self.assertRaises(ValueError): deploy.configuration({**configuration(),key:invalid})

    def test_explicit_profile_and_no_shell_in_deployment_command(self):
        args=deploy.deploy_arguments(configuration(),'set-kintai-dev')
        self.assertEqual(args[:4],['sam','deploy','--profile','set-kintai-dev'])
        self.assertIn('ParameterKey=TemplateKey,ParameterValue=""',args)
        self.assertIn('ParameterKey=Stage,ParameterValue="development"',args)
        self.assertNotIn('CAPABILITY_IAM',args)
        for profile in [None,'','--debug','name with spaces','bad;command']:
            with self.subTest(profile=profile), self.assertRaises(ValueError): deploy.deploy_arguments(configuration(),profile)

    def arguments(self, directory, *extra):
        path=Path(directory,'deploy.local.json')
        import json
        path.write_text(json.dumps(configuration()))
        return ['aws-deploy.py','--config',str(path),*extra]

    def test_check_mode_never_calls_aws(self):
        with tempfile.TemporaryDirectory() as directory, patch('sys.argv',self.arguments(directory)), patch.object(subprocess,'run') as run, contextlib.redirect_stdout(io.StringIO()):
            deploy.main();run.assert_not_called()

    def test_github_execution_and_missing_profile_stop_before_checks_and_aws(self):
        with tempfile.TemporaryDirectory() as directory:
            for environment, extra in [({'GITHUB_ACTIONS':'true'},['--profile','set-kintai-dev']),({},[])]:
                with patch.dict(os.environ,environment,clear=True), patch('sys.argv',self.arguments(directory,'--deploy',*extra)), patch.object(deploy,'local_checks') as checks, patch.object(subprocess,'run') as run:
                    with self.assertRaises(ValueError): deploy.main()
                    checks.assert_not_called();run.assert_not_called()

    def test_only_temporary_roles_in_target_account_are_accepted(self):
        account=configuration()['AWS_ACCOUNT_ID']
        deploy.validate_identity({'Account':account,'Arn':f'arn:aws:sts::{account}:assumed-role/SSODeveloper/session'},account)
        for identity in [{'Account':'999988887777','Arn':'arn:aws:sts::999988887777:assumed-role/SSODeveloper/session'},
                         {'Account':account,'Arn':f'arn:aws:iam::{account}:root'},
                         {'Account':account,'Arn':f'arn:aws:iam::{account}:user/admin'},{}]:
            with self.assertRaises(ValueError): deploy.validate_identity(identity,account)

    def test_dirty_tree_stops_before_build_or_aws(self):
        response=subprocess.CompletedProcess([],0,' M backend/src/service.cjs')
        with patch.object(subprocess,'run',return_value=response) as run:
            with self.assertRaises(ValueError): deploy.local_checks()
            self.assertEqual(run.call_count,1)
            self.assertEqual(run.call_args.args[0][:2],['git','status'])

    def test_local_failures_prevent_aws_calls(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,{},clear=True), patch('sys.argv',self.arguments(directory,'--deploy','--profile','set-kintai-dev')), patch.object(deploy,'local_checks',side_effect=ValueError('validation failed')), patch.object(subprocess,'run') as run:
            with self.assertRaises(ValueError): deploy.main()
            run.assert_not_called()

    def test_wrong_account_stops_before_sam_deploy(self):
        response=subprocess.CompletedProcess([],0,'{"Account":"999988887777","Arn":"arn:aws:sts::999988887777:assumed-role/SSODeveloper/session"}')
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,{},clear=True), patch('sys.argv',self.arguments(directory,'--deploy','--profile','set-kintai-dev')), patch.object(deploy,'local_checks'), patch.object(subprocess,'run',return_value=response) as run:
            with self.assertRaises(ValueError): deploy.main()
            self.assertEqual(run.call_count,1)
            self.assertEqual(run.call_args.args[0][:3],['aws','--profile','set-kintai-dev'])

    def test_bootstrap_uses_selected_aws_profile_without_external_trust(self):
        response=subprocess.CompletedProcess([],0,'{"Stacks":[{"Outputs":[]}]}')
        with patch('sys.argv',['bootstrap-aws.py','--profile','admin-sso']), patch.object(subprocess,'run',return_value=response) as run, contextlib.redirect_stdout(io.StringIO()):
            bootstrap.main()
            self.assertEqual(run.call_count,2)
            args=run.call_args_list[0].args[0]
            self.assertEqual(args[:3],['aws','--profile','admin-sso'])
            self.assertIn('set-kintai-deployment-development',args)
            self.assertFalse(any('github' in arg.lower() or 'oidc' in arg.lower() for arg in args))

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
