# ローカルGitからAWSへ直接配置

ソースと履歴はローカルGitで管理し、開発PCまたは配置用のローカルサーバーからAWS CLI／SAM CLIで直接配置します。GitHubとの認証連携、GitHub ActionsからのAWS配置、GitHub Secretsは使いません。AWSへの接続は、管理者が用意したIAM Identity CenterのSSOプロファイルと一時資格情報を使います。

```text
開発PC → ローカルGitにコミット → 必要なら社内Gitサーバーへpush
配置するPC／サーバー → AWSへログイン → 検査・ビルド → AWSに配置
```

Gitで履歴を保存し、AWSへの反映はデプロイコマンドで行います。配置サーバーへのインターネットからの着信や、公開SSH・Webhookは不要です。ローカルGitは別媒体・別ホストにも履歴ごとバックアップしてください。

現在の画面はまだGitHub Pages、勤怠保存はブラウザ内です。AWS初回設定・Microsoft 365の本物のログイン・画面のAPI接続・画面のS3＋CloudFrontへの移行は、それぞれ実設定が必要です。現在の公開画面をAWSへ移して動作確認した後、旧公開先を終了できます。

## 秘密情報と設定の保管場所

| 内容 | 場所 |
| --- | --- |
| コード、AWS構成、設定例 | ローカルGit |
| AWS CLIのSSO設定・セッション | AWS CLIが管理するユーザー領域。リポジトリ外 |
| アカウントID・ロールARN・バケット名・Entra ID | `deploy.local.json`。Git対象外。秘密鍵は入れない |
| ログイン用パスワード | Microsoft 365。勤怠アプリは保存しない |
| 将来の通知用秘密鍵など | AWS Secrets Manager |
| 社員の勤怠・個人設定 | DynamoDB |
| 実Excel・提出ファイル | 非公開S3 |

フロントのJavaScriptに入れた値はブラウザから見えます。秘密情報を使う処理はサーバー側で行います。固定のAWSアクセスキーをアプリやGitに保存しません。

## ローカルの必要ツールと検査

Git、Python 3.10以降、Node.js 24、AWS CLI v2、SAM CLI 1.171.0、makeを用意します。Linux/macOSを想定し、WindowsはWSLを使います。Gitleaks 8.30.1は同梱のインストーラーで取得・SHA-256検証します。

```sh
python3 scripts/security/install.py --destination "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
git config core.hooksPath .githooks
python3 scripts/security/check.py
```

`.gitignore`とコミット前のhookで、`.env`・鍵・実設定・社員プロフィール・Excel・CSV等の誤追加を防ぎ、Gitleaksで秘密情報のパターンを検査します。強制追加も検査対象です。検出した値は表示せず、ファイル・行番号・検出ルールだけを表示します。個人情報の意味を完全に判定する仕組みではないため、実データは`private/`などの非追跡領域で扱います。

既存のGitHub側にある検証workflowは旧公開先を維持している間のコード検査だけで、AWSの認証・配置はできません。今後の配置はローカルの検査で完結します。

## 1. AWSへのログインを準備

AWS管理者がIAM Identity Centerを設定し、開発用アカウントに利用者と権限セットを割り当てます。勤怠アプリ用のMicrosoft 365ログインとは別の、AWS管理操作用の設定です。会社のSSOを使う場合はその管理設定に従います。

初回設定を行う管理用プロファイルと、日常配置用のプロファイルを分けます。既存のプロファイル名を使う場合は、以下の名前を読み替えます。

```sh
aws configure sso --profile set-kintai-admin
aws sso login --profile set-kintai-admin
```

SSO開始URLとSSOリージョンは管理者が指定した値を使います。アプリの配置先は東京`ap-northeast-1`です。SSOをまだ設定していない場合、AWSコンソールに入れたことだけでこのコマンドが使える状態になったとは扱いません。

## 2. 初回のAWS権限を準備

管理用SSOプロファイルで次を実行します。CloudShellで行う場合は、ソースをアップロードしてから`--profile`を省略し、コンソールの認証を使えます。

```sh
python3 scripts/bootstrap-aws.py --profile set-kintai-admin
```

`set-kintai-deployment-development`スタックで作成するもの:

- 配置ZIP用の非公開・暗号化・バージョニング付きS3。
- CloudFormation用の構成変更ロール。
- 勤怠Lambda用の実行ロール。
- 日常の配置担当に割り当てる`set-kintai-development-deploy`管理ポリシー。

外部IDプロバイダーやGitHubを信頼するロールは作りません。ここでは勤怠DB・API・Lambdaもまだ作りません。

管理者は、出力された配置用ポリシーをIAM Identity Centerの配置担当の権限セットに「カスタマー管理ポリシー参照」として追加し、対象AWSアカウントへプロビジョニングします。日常配置は開発用スタック・配置用バケットと、指定のCloudFormationロールを渡す操作に限定します。CloudFormation用ロールもIAMロールの作成・権限変更はできません。HTTP APIのIDは作成前に決まらないため、その管理操作は東京のHTTP API用パスに限定しています。

表示された4項目を、次の設定ファイルへコピーします。

```sh
cp backend/examples/deploy.example.json deploy.local.json
```

`AWS_ACCOUNT_ID`、`AWS_CLOUDFORMATION_ROLE_ARN`、`AWS_LAMBDA_ROLE_ARN`、`AWS_ARTIFACT_BUCKET`を埋めます。既存の実設定ファイルには`cp`で上書きせず、必要な値を編集してください。

## 3. Microsoft 365のAPI設定を追加

`deploy.local.json`の`ENTRA_TENANT_ID`に会社のテナントUUID、`ENTRA_API_AUDIENCE`に勤怠APIアプリのclient ID（v2アクセストークンのaudience）を設定します。画面側アプリやMicrosoft GraphのIDを使いません。`ENTRA_REQUIRED_SCOPE`は委任scope名で、初期値は`access_as_user`です。

`TEMPLATE_KEY`と`TEMPLATE_MAPPING_KEY`は初回は両方空欄にします。この場合、会社Excel出力は無効です。設定する場合は承認したテンプレートとセル設定を非公開S3の`templates/`以下に置き、両方のキーを指定します。ファイル本体や社員情報をGitに入れません。

```sh
python3 scripts/aws-deploy.py --config deploy.local.json
```

この設定確認だけではAWSに接続しません。必要な設定が不足していれば失敗し、認証を外して配置する回避経路はありません。

## 4. ローカルから開発用APIを配置

日常の配置用SSOプロファイルを設定し、コミット済みのソースから実行します。

```sh
aws configure sso --profile set-kintai-dev
aws sso login --profile set-kintai-dev
python3 scripts/aws-deploy.py --profile set-kintai-dev --config deploy.local.json --deploy
```

実行順は、設定確認 → コミット漏れ確認 → 秘密情報検査・ガードのテスト → 本番依存監査・APIテスト → AWS構成検証・ビルド → 接続先AWSアカウントと一時ロールの確認 → SAMで直接配置、です。シェルとして設定値を評価せず、指定のAWSプロファイルをAWS CLIとSAMの両方へ渡します。未コミットのコード、設定不足、検査失敗、別アカウント、IAMユーザー／ルートの資格情報では配置を止めます。GitHub Actions上の配置実行も拒否します。

対象は東京の`set-kintai-development`だけです。API GatewayでMicrosoft 365のトークン署名・発行者・audience・scopeを検証する構成を維持します。今回の配置はAPI用で、画面の保存先は切り替わりません。同じ環境へ複数の端末から同時に配置しないでください。

実AWSへの初回配置は、管理者のSSO権限と実際のEntra設定が揃ってから確認します。ローカル検証だけでAWS上の権限や本番認証試験が完了したとは扱いません。

## バックアップと旧公開先の終了

Git履歴込みのバックアップは`git bundle create /安全な保存先/set-kintai.bundle --all`で作れます。別の端末では`git clone /保存先/set-kintai.bundle set-kintai`で復元できます。Git対象外の個人設定・AWS CLIのログイン状態は含みません。不要なGitHubリモートを登録せず、社内Gitサーバーを使う場合だけそのリモートを設定します。

画面をS3＋CloudFrontへ移し、ログインの戻り先URL・APIの許可origin・iPhoneのホーム画面追加を確認してから、旧GitHub Pagesと残るGitHub側の検証・年次祝日更新を終了します。祝日更新は同梱スクリプトをローカルでも実行でき、AWS側での定期実行は別途設定します。

DynamoDB・業務ファイル用S3・配置用S3はスタック削除時にも保持します。保存期間・旧版整理・復旧は運用ルールに沿って管理します。

参照: [AWS CLIのSSO設定](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)、[SAMでの配置](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/using-sam-cli-deploy.html)。
