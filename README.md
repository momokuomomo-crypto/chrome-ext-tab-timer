# 会議終了タブ・タイマー

タブに時限タイマーを設定し、時間になったら通知するChrome拡張機能
（Manifest V3）。

[ai-council v2](https://github.com/momokuomomo-crypto/ai-council_v2)の
会合で検討・承認された
[稟議書](https://github.com/momokuomomo-crypto/ai-council-output/blob/master/chrome-extension-ideas/稟議書_Chrome拡張機能アイデア.md)
をもとに、
[ai-build-council](https://github.com/momokuomomo-crypto/ai-build-council)
のワークフローで設計・実装した。

## 主な機能

- ポップアップ（プリセット15/30/60分/2時間＋任意日時）または右クリック
  メニュー（プリセット15/30/60分）からタブ単位の一回限りタイマーを設定
- タブIDに紐付けつつ、自動キャンセル判定はorigin＋pathnameのみを比較
  （クエリ・ハッシュだけの変更では無音失効しない。会議・配信アプリの
  UI状態やトークン更新に対応）
- `chrome.storage.local`を真実源、`chrome.alarms`を実行スケジューラとし、
  `scheduled→firing→notified`という状態を通知作成前に永続化することで
  二重発火・見逃しを防ぐ

## セットアップ

```bash
npm install
npm run build
```

`chrome://extensions` でデベロッパーモードを有効にし、
「パッケージ化されていない拡張機能を読み込む」で`dist/`を選択する。

## 開発

```bash
npm run dev         # 開発用ビルド（watch）
npm run typecheck
npm run lint
npm run test         # 単体・統合テスト（Vitest, sinon-chrome）
npm run build        # 本番ビルド
```

## ディレクトリ構成

```
src/
  background/
    index.ts            # Service Worker（alarm処理・整合性チェック）
    storage.ts            # chrome.storage永続化
    timer-service.ts       # タイマーの状態遷移ロジック
  popup/                   # ツールバーpopup UI
  shared/
    timer-logic.ts          # 発火判定・自動キャンセル判定
    timer-types.ts
tests/
  unit/                      # 純粋関数の単体テスト（Vitest）
  integration/                 # background/index.tsの統合テスト（sinon-chrome）
```

## 収益化方法

無料3件まで。Pro版で定型タイマーを提供する。

## 将来の拡張案

- 閲覧時間の上限
- 集中モード

出典：[稟議書_Chrome拡張機能アイデア.md（項目9）](https://github.com/momokuomomo-crypto/ai-council-output/blob/master/chrome-extension-ideas/稟議書_Chrome拡張機能アイデア.md)

## 開発の経緯

[ai-build-council](https://github.com/momokuomomo-crypto/ai-build-council)
のゲート付きワークフロー（独立設計→設計査読→実装→テスト→固定diffの
独立実装レビュー→修正→記録）で設計・実装した。

Codex CLIとClaude Agentを並列実行した実装レビューで、**両者が独立に
同一の核心的な不具合**を発見した：一回限りのalarmは発火後にChrome側で
自動削除されるため「alarm無し」の状態が自然に生じるが、整合性チェックが
これを「再作成すべき未来のタイマー」と誤認識し、過去の時刻でalarmを
再作成→ほぼ即座に再発火→同じ通知IDで再通知、という経路があった。
「一回限りタイマー・二重発火防止」という中核要求への直接的な違反であり、
発火処理の冒頭で状態を確認するガードを追加して修正した。またブラウザ
全体再起動とService Worker単体再起動の判別を、イベント配送順序に依存
しない`chrome.storage.session`ベースの方式へ変更している。
