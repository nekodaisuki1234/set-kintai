# AWSへの接続準備（開発環境）

この手順は、公開／非公開どちらのリポジトリでも長期AWSアクセスキーを保存せずに運用するためのものです。画面はまだGitHub Pages、勤怠保存はブラウザ内です。AWSの初回設定が終わるまで実際の接続・配置は行われません。

## 保管場所

| 内容 | 保管場所 |
| --- | --- |
| コード、AWS構成、値を含まない設定例 | Git |
| AWSアカウントID・ロールARN・バケット名、EntraテナントID・APIアプリID | GitHub Actions **Variables**（秘密ではない環境設定） |
| ログイン用パスワード | Microsoft 365。勤怠アプリは保存しない |
| AWSアクセスキー | 発行・GitHub登録不要。ActionsはOIDC、LambdaはIAMロール |
| 将来必要になる通知用秘密鍵・外部APIの秘密情報 | AWS Secrets Manager。今回のAPIにはまだ不要 |
| 社員プロフィール、勤怠、本人の設定 | DynamoDB |
| 実際の会社Excel・提出ファイル・スナップショット | 非公開S3 |

フロントのJavaScriptに埋め込んだ値は利用者から見えます。GitHub Secretsからビルドへ渡しても秘密にはなりません。機密情報を扱う処理はサーバー側に置きます。

## 誤コミット防止

`.gitignore` は `.env`、ローカルAWS資格情報、鍵、SAMの実設定、個人プロフィール、Excel・CSVなどを対象外にします。`scripts/security/check.py` は強制追加されたファイルも拒否し、Gitleaks 8.30.1で秘密情報のパターンを検査します。ツールの配布物はSHA-256を確認してからインストールします。

ローカルの初回設定（Linux/macOS。WindowsはWSL）:

```sh
python3 scripts/security/install.py --destination "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
git config core.hooksPath .githooks
python3 scripts/security/check.py
```

`pre-commit` はステージ済みの内容を検査します。未導入・検査失敗時はコミットを止めます。GitHubの **Repository security** はpush・PR・手動実行時に全追跡ファイルと取得したGit履歴を検査します。CIは`fetch-depth: 0`で全履歴を取得し、過去に追加後削除された秘密情報も対象にします。検出した値・行の内容・スキャナの生ログは公開せず、ファイル名・行番号・ルール・コミットだけを出します。

CIはpush後に動くため、公開を事前に止める仕組みとして、GitHubの **Settings → Code security / Secret protection** で利用可能なSecret scanningとPush protectionも有効にしてください。設定名・利用可否はアカウント／プランによります。さらにmainへの変更に **Private files and secret history** を必須チェックとして設定すると、失敗したPRのマージを防げます。これらGitHub管理設定は、このコードの追加だけでは変更されません。

検査は社員の個人情報を意味から完全に判定するものではありません。実社員データは`private/`等の非追跡領域で扱います。実際の資格情報を公開した場合は、ファイルを消すだけでなく発行元で失効・再発行してください。元のレポートをIssueやチャットへ貼りません。

## 1. GitHubが発行する識別子を確認

[Repository security](https://github.com/nekodaisuki1234/set-kintai/actions/workflows/repository-security.yml) のmain実行を開き、**OIDC bootstrap identity** のSummaryにある `subject` をコピーします。トークン本体は表示しません。AWSへの接続もまだ行いません。

GitHubでは作成時期・設定によりsubjectにIDが付く形式があるため、名前だけで推測せず、実際の値を使います。このリポジトリID `1414011126`、所有者ID `79440835` と `refs/heads/main` を検査します。PR、fork、他のブランチ、Environment用のsubjectは拒否します。

## 2. AWS CloudShellで初回設定

東京リージョン `ap-northeast-1` を開き、IAMロール・OIDCプロバイダー・CloudFormation・S3を設定できる管理用のログインでCloudShellを起動します。アクセスキーをチャットやGitに渡す必要はありません。

```sh
git clone https://github.com/nekodaisuki1234/set-kintai.git
cd set-kintai
python3 scripts/bootstrap-aws.py --subject '上で確認したsubjectを貼る'
```

このコマンドは `set-kintai-oidc-development` スタックを作成／更新し、次を準備します。

- GitHubのOIDCプロバイダー。既存の共有プロバイダーがあれば流用し、設定を置き換えません。
- このリポジトリのmainだけを信頼するデプロイ用IAMロール。
- CloudFormation用の構成変更ロールと、Lambda用の実行ロール。
- 配置用ZIPを置く非公開・暗号化・バージョニング付きS3バケット。

ここでは勤怠のDynamoDB・API・Lambdaは作成しません。GitHubのロールにはAdministratorAccess、IAMロールの作成・権限変更、勤怠データへの直接アクセスを与えません。CloudFormationもIAMロールの権限を書き換えず、事前作成済みの実行ロールだけをLambdaへ渡します。DynamoDB・S3・Lambda・ログは開発用の固定リソースに限定します。HTTP APIは作成前にIDが不明のため、構成変更ロールのAPI Gateway管理権限は東京リージョンのHTTP API用パスに限定しています。開発用AWSアカウントを分ける構成を推奨します。

表示された次の5項目を、GitHubの [Settings → Secrets and variables → Actions → Variables](https://github.com/nekodaisuki1234/set-kintai/settings/variables/actions) に登録します。**SecretsではなくVariables**です。

| Variable | 値 |
| --- | --- |
| `AWS_ACCOUNT_ID` | AWSアカウントID |
| `AWS_DEPLOY_ROLE_ARN` | GitHub用ロールARN |
| `AWS_CLOUDFORMATION_ROLE_ARN` | CloudFormation用ロールARN |
| `AWS_LAMBDA_ROLE_ARN` | Lambda用ロールARN |
| `AWS_ARTIFACT_BUCKET` | 配置ファイル用S3バケット名 |

GitHub Environmentはこの手順では設定しません。Environmentを使うとOIDC subjectが変わるため、導入する場合は信頼ポリシーと検査を併せて変更します。

## 3. Microsoft 365の登録後に追加する設定

以下が未設定の間、デプロイworkflowはAWS資格情報を取得する前に停止します。認証なしでAPIを作る回避経路は用意しません。

| Variable | 値 |
| --- | --- |
| `ENTRA_TENANT_ID` | 勤怠を利用する会社のテナントUUID |
| `ENTRA_API_AUDIENCE` | 勤怠APIアプリのclient ID（v2アクセストークンのaudience）。画面側アプリやMicrosoft GraphのIDを使わない |
| `ENTRA_REQUIRED_SCOPE` | 委任scope名。省略時 `access_as_user` |
| `TEMPLATE_KEY` | 承認した会社ExcelのS3キー。初回は空欄 |
| `TEMPLATE_MAPPING_KEY` | 対応するセル設定のS3キー。初回は空欄 |

テンプレートの2項目は両方を空欄にするとExcel出力を無効化します。設定する場合は両方を`templates/`以下のキーにします。実ファイルや社員情報はGitに追加しません。これらはアプリログインの完成とは別工程です。

## 4. 開発用APIの配置

[**AWS development deploy**](https://github.com/nekodaisuki1234/set-kintai/actions/workflows/aws-development-deploy.yml) で **Run workflow → main** を選びます。pushだけではAWSへ配置しません。

設定チェック → 秘密情報検査 → ガードのテスト → 本番依存監査・APIテスト → AWS構成検証・ビルド → 別ジョブで成果物のSHA-256を確認 → OIDCで一時資格情報を取得 → 配置、の順です。依存関係のインストール・テスト・ビルドのジョブにはOIDCトークンの発行権限を与えません。第三者ActionはコミットSHA、SAM CLIはバージョンを固定します。外部入力をシェルコマンドとして評価せず、AWSアカウントと実際に引き受けたロールも確認します。同時デプロイは直列に処理します。

対象は東京の `set-kintai-development` だけです。本番環境の自動作成や、認証を外したお試しAPIの配置は行いません。AWS API Gatewayがトークンの署名・発行者・audience・scopeを検証する構成を維持します。フロントの保存先はこのデプロイでは切り替わりません。

AWS上での最初の配置は実アカウントの権限とEntra設定が揃ってから確認します。ローカルテスト・SAM検証だけで、実AWSの権限確認や本番認証試験が完了したとは扱いません。

## AWSへ画面も移した後のGitHub非公開化

画面をS3＋CloudFrontへ移し、ログインの戻り先URL、APIの許可origin、iPhoneのホーム画面追加を新しい公開先で確認してからGitHubを非公開にします。今回のworkflowはAPI用で、画面のAWSホスティングは別工程です。OIDCとCLI版Gitleaksの検査は非公開化後も利用できます。非公開化後のCloudShellでのソース取得にはGitHubへの認証が必要ですが、PATをURLやシェル履歴へ埋め込みません。

## 検証・復旧

- 検査は `python3 -m unittest discover -s tests/security -p 'test_*.py'` と `node --test tests/security/oidc.test.cjs`。GitleaksをPATHに入れて実行します。
- AWS構成は `sam validate --lint --template-file backend/infra/github-oidc.yaml --region ap-northeast-1` とアプリ用`template.yaml`で検証します。
- 配置失敗時はCloudFormationのイベントを確認し、原因を直して同じworkflowを再実行します。資格情報や社員データをログへ追加して調査しません。
- アプリのDynamoDB・S3は削除時も保持します。初回設定のOIDCプロバイダー・配置用S3も保持し、共有プロバイダーを自動削除しません。使用しなくなった版や保持データの削除は、運用ルールに沿って別途行います。

参照: [GitHub OIDCとAWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)、[IAM OIDCProvider](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-iam-oidcprovider.html)、[Gitleaks](https://github.com/gitleaks/gitleaks)。
