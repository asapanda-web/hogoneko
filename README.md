# 犬猫の健康管理アプリ

保護団体内の複数人でログインして使う、犬猫の健康管理Webアプリです。
GitHub Pages(画面の公開)+ Firebase(ログイン・データ保存)で動きます。

## セットアップ手順

### 1. Firebaseプロジェクトを作る
1. https://console.firebase.google.com/ でプロジェクトを作成
2. 「Authentication」→「Sign-in method」→「メール/パスワード」を有効化
3. 「Firestore Database」→ データベースを作成(リージョンは `asia-northeast1` 推奨)
4. 「Firestore Database」→「ルール」タブ → このフォルダの `firestore.rules` の内容を貼り付けて公開
5. 「プロジェクトの設定」→「マイアプリ」→ ウェブアプリを追加 → 表示される設定値をコピー

### 2. 設定を貼り付ける
`firebase-config.js` を開き、`firebaseConfig` の中身をFirebaseコンソールで表示された値に置き換える。

### 3. GitHubにアップロードしてGitHub Pagesで公開
1. GitHubリポジトリにこのフォルダの全ファイルをアップロード
2. リポジトリの「Settings」→「Pages」→ ブランチを選んで公開
3. 公開されたURLの `index.html` にアクセスすればログイン画面が表示される

### 4. 使い方
- 初回はメールアドレス・パスワードで「新規登録」する(団体のメンバー全員分アカウントを作る、または1つのアカウントを共有してもOK)
- ログイン後、右下の「+」から犬猫を登録(登録時に犬/猫を選べます)
- 登録した動物をタップすると「日々の記録」「医療記録」を追加できる
- 団体の全メンバーが同じデータを見られる(ログインさえしていれば誰でも閲覧・編集可能)

## ファイル構成
- `index.html` / `auth.js` … ログイン・新規登録画面
- `app.html` / `app.js` … 犬猫の一覧・詳細・記録画面
- `firebase-config.js` … Firebaseの接続設定(自分の値に書き換える)
- `firestore.rules` … Firestoreのセキュリティルール(Firebaseコンソールに貼り付ける)
- `style.css` … デザイン

## 今後拡張したいときのヒント
- 犬猫の写真をアップロードしたい → Firebase Storageを追加
- メンバーごとに権限を分けたい → Firestoreルールをユーザーの役割で分岐させる
- 体重の推移をグラフで見たい → Chart.jsなどを追加してdailyLogsのweightを描画
