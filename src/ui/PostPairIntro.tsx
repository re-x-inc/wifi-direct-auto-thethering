import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useState } from 'react';
import { Button, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';

const KEY = 'tether.postPair.v1';

/** ペアリング直後の案内を見たか(端末内に保存)。読み終えるまで loaded は false */
export function usePostPairSeen() {
  const [seen, setSeen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    SecureStore.getItemAsync(KEY).then((v) => { if (alive) { setSeen(v === '1'); setLoaded(true); } }).catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);
  const markSeen = useCallback(() => { setSeen(true); void SecureStore.setItemAsync(KEY, '1').catch(() => {}); }, []);
  // ペアを全部消したら、次のペアリングでもう一度出す
  const reset = useCallback(() => { setSeen(false); void SecureStore.deleteItemAsync(KEY).catch(() => {}); }, []);
  return { seen, loaded, markSeen, reset };
}

export const POST_PAIR_ITEMS = [
  { head: '自動でつながります', body: 'ペアにした相手が近くにいれば、自動で接続します。切れても、近づけば自分でつなぎ直します。' },
  { head: '回線のある端末が親機です', body: '親機で「共有」を押すと、相手の端末が親機の回線を使えるようになります。' },
  { head: '許可の画面が出たら', body: 'Wi-Fi への参加や VPN の確認が出たら、「許可」「OK」を選んでください。' },
];

export function PostPairIntro({ visible, onDone }: { visible: boolean; onDone: () => void }) {
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onDone}>
      <ScrollView style={{ backgroundColor: '#fff' }} contentContainerStyle={styles.root}>
        <Text style={styles.ok}>ペアリングが完了しました</Text>
        <Text style={styles.h}>次にやること</Text>
        {POST_PAIR_ITEMS.map((x) => (
          <View key={x.head} style={styles.card}>
            <Text style={styles.head}>{x.head}</Text>
            <Text style={styles.body}>{x.body}</Text>
          </View>
        ))}
        <Button title="わかりました" onPress={onDone} />
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { padding: 24, paddingTop: 64, gap: 12 },
  ok: { fontSize: 14, fontWeight: '700', color: '#1b7f3b' },
  h: { fontSize: 24, fontWeight: '700' },
  card: { backgroundColor: '#f3f3f3', borderRadius: 8, padding: 12, gap: 4 },
  head: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 14, color: '#333' },
});
