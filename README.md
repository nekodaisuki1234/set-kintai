# SET 勤怠

勤怠の記録・確認・Excel出力を扱うアプリと、AWS向けAPIのリポジトリです。

公開入口: https://nekodaisuki1234.github.io/catGame/

トップページからAデザインのログイン画面を開きます。Microsoft 365の実ログインとAWSへの接続は準備中です。画面にはその状態を明示しており、認証済みの本番システムではありません。

## 構成

- [day-designs/](day-designs/README.md): Aデザインの勤怠画面、ログインプレビュー、ブラウザ内の保存処理、祝日・通知の準備。
- [backend/](backend/README.md): Microsoft Entra IDのJWT認証を前提としたAPI、DynamoDB・S3用の構成、会社帳票の`.xlsm`出力。
- [attendance-demo/](attendance-demo/README.md): 以前の勤怠プロトタイプとデザイン案。
- `tests/paper-*.cjs`: 勤怠の計算・保存・画面の検証。
- `scripts/update-paper-holidays.cjs`: 公式祝日データの更新処理。

現在の勤怠画面・保存データ・既存の公開URLは維持しています。猫カフェのゲーム本体、画像、専用テストは削除しました。削除前の内容はGitの履歴に残っています。

## 開発時の確認

画面側の検証は[Paper attendance checks](.github/workflows/paper-checks.yml)で実行します。API・帳票の検証は以下です。

```sh
npm ci --prefix backend --ignore-scripts
npm test --prefix backend
```

AWS配置・認証の設定手順は[バックエンドの説明](backend/README.md)を参照してください。会社テンプレートや社員の実績ファイルは公開リポジトリには含めません。
