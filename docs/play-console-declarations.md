# Play Console 申告メモ

- 位置情報(バックグラウンド)(ACCESS_BACKGROUND_LOCATION): 用途=画面オフ・背面でも親機(Wi-Fi Direct / Nearby)との接続を保つため。位置情報そのものは取得・保存・送信しない(Nearby の探索がシステムに位置情報権限を求められるため)。
- フォアグラウンドサービスの種類: connectedDevice と location(FOREGROUND_SERVICE_LOCATION)。用途=同上。
