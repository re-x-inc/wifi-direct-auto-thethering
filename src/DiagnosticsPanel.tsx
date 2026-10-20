import { useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import type { Tether } from './api';

const COLOR = { primary: '#1b6b4a', onPrimary: '#ffffff', container: '#cfe9dc', text: '#1a1c1b', sub: '#5c635f', card: '#eef2ef', error: '#b3261e' };

/** 文字つきボタン(アイコンだけのボタンは使わない) */
function TextButton({ title, onPress, filled, disabled }: { title: string; onPress(): void; filled?: boolean; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={title}
      style={[s.btn, { backgroundColor: filled ? COLOR.primary : COLOR.container, opacity: disabled ? 0.38 : 1 }]}>
      <Text style={{ color: filled ? COLOR.onPrimary : '#0b2e20', fontSize: 16, fontWeight: '600' }}>{title}</Text>
    </Pressable>
  );
}

/**
 * 開発用の診断画面。端末から取れるものを網羅的に採取した「診断レポート」を作り、
 * 端末内のファイルに保存し、利用者が押したときだけ共有(外へ出力)する。
 * 相手の端末へは自動では送らない(ハンドシェイクで送るのは方式判断に使う能力のみ)。
 */
export function DiagnosticsPanel({ tether }: { tether: Tether }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ summary: string; json: string; fileName: string; path: string | null } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try { await f(); } catch (e: any) { setMsg(String(e?.message ?? e)); } finally { setBusy(false); }
  };

  const collect = () => run(async () => {
    const r = await tether.saveDiagnosticReport();
    setOut({ summary: r.summary, json: r.json, fileName: r.fileName, path: r.path });
  });

  const probe = () => Alert.alert(
    'LocalOnlyHotspot を試す',
    'Wi-Fi が一時的に切れる場合があります。共有中は実行できません。続けますか?',
    [
      { text: 'キャンセル', style: 'cancel' },
      { text: '試す', onPress: () => void run(async () => {
        const r = await tether.runProbe();
        setMsg(`LocalOnlyHotspot: ${r.lohs.ok ? '作成できました' : `作成できませんでした(${r.lohs.reason ?? '理由不明'})`}。レポートを作り直します`);
        const saved = await tether.saveDiagnosticReport();
        setOut({ summary: saved.summary, json: saved.json, fileName: saved.fileName, path: saved.path });
      }) },
    ],
  );

  const share = () => {
    if (!out) return;
    // 利用者が押したときだけ外へ出す。機種名と能力のみで、個人を特定する値・共有コード・資格情報は含まれない
    void Share.share({ title: out.fileName, message: out.json }).catch(() => {});
  };

  return (
    <View style={s.card}>
      <Text style={s.title}>診断(開発用)</Text>
      <Text style={s.sub}>端末の能力を網羅的に採取し、機種ごとの JSON を保存します。電話番号・SSID・MAC・アカウント等は採取しません。</Text>
      <TextButton title={open ? '診断を閉じる' : '診断を開く'} onPress={() => setOpen(!open)} />
      {open && (
        <View style={{ gap: 8 }}>
          <TextButton filled title="診断レポートを作って保存" onPress={() => void collect()} disabled={busy} />
          <TextButton title="LocalOnlyHotspot を試す(Wi-Fi が一時的に切れる場合あり)" onPress={probe} disabled={busy} />
          <TextButton title="レポートを共有(JSON)" onPress={share} disabled={busy || !out} />
          {msg && <Text style={s.msg}>{msg}</Text>}
          {out && (
            <>
              <Text style={s.sub}>{out.path ? `保存先: ${out.path}` : '保存先なし(共有で取り出してください)'}</Text>
              <Text style={s.sub}>PC へ: adb pull で上記の diagnostics フォルダを取得、または共有を使う</Text>
              <ScrollView style={s.box} nestedScrollEnabled>
                <Text style={s.mono} selectable>{out.summary}</Text>
              </ScrollView>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: COLOR.card, borderRadius: 20, padding: 18, gap: 10, marginTop: 12 },
  title: { fontSize: 18, color: COLOR.text, fontWeight: '600' },
  sub: { fontSize: 13, color: COLOR.sub },
  msg: { fontSize: 14, color: COLOR.error },
  btn: { minHeight: 48, borderRadius: 24, paddingHorizontal: 20, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' },
  box: { maxHeight: 360, backgroundColor: '#ffffff', borderRadius: 12, padding: 10 },
  mono: { fontSize: 11, fontFamily: 'monospace', color: COLOR.text },
});
