import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, type ScrollViewInstance, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Confirm, Found, getTether, Identity, Pair, TetherState } from './src/api';
import { DiagnosticsPanel } from './src/DiagnosticsPanel';
import { PostPairIntro, usePostPairSeen } from './src/ui/PostPairIntro';
import { type LinkPhase, linkSummary } from './src/ui/connectText';

const hhmmss = () => new Date().toTimeString().slice(0, 8);

const LINK_TEXT = { stopped: '停止', connecting: '接続中', waiting: '再試行待ち', connected: '接続済み' } as const;
const SHARE_TEXT = { off: '—', starting: '準備中', on: '共有中', failed: '失敗' } as const;
const VPN_TEXT = { off: '—', 'awaiting-permission': '許可待ち', starting: '起動中', on: '通信中', failed: '失敗', held: '停止中(非常口)' } as const;

type PairingUi = { role: 'host' | 'guest'; devices: Found[]; confirm: Confirm | null; message: string; waiting: boolean };

/** 公開 API(src/api)だけで作った、最小の操作画面。ペアを作れば あとは自動で接続・共有・復旧する。 */
export default function App() {
  const tether = getTether();
  const [s, setS] = useState<TetherState>(tether.getState());
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [pairs, setPairs] = useState<Pair[]>([]);
  // undefined = 読み込み中 / null = 未選択(初回の選択画面を出す)
  const [introDone, setIntroDone] = useState(false);
  const [deviceRole, setDeviceRole] = useState<'host' | 'guest' | null | undefined>(undefined);
  const [pairing, setPairing] = useState<PairingUi | null>(null);
  const intro = usePostPairSeen();
  const [introVisible, setIntroVisible] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const ctl = useRef<{ connectTo(id: string): void; cancel(): void } | null>(null);

  const reload = async () => setPairs(await tether.pairs());
  const run = (p: Promise<unknown>) => p.catch((e) => setLog((l) => [`${hhmmss()} ${e?.message ?? e}`, ...l].slice(0, 60)));

  useEffect(() => {
    const off1 = tether.subscribe(setS);
    const off2 = tether.onLog((line) => setLog((l) => [`${hhmmss()} ${line}`, ...l].slice(0, 60)));
    void (async () => {
      setIdentity(await tether.identity());
      setDeviceRole(await tether.deviceRole());
      await reload();
      // ペアがあれば、起動しただけで接続を始める(人手を減らす)
      if ((await tether.pairs()).length && !tether.getState().started) await run(tether.start());
    })();
    return () => { off1(); off2(); };
  }, []);

  const addPair = async (role: 'host' | 'guest') => {
    const perm = await tether.ensurePermissions();
    if (!perm.granted) {
      Alert.alert('権限が足りません', perm.missing.map((m) => m.slice(m.lastIndexOf('.') + 1)).join(', ') || '権限を許可してください');
      return;
    }
    setPairing({ role, devices: [], confirm: null, message: '', waiting: false });
    ctl.current = await tether.beginPairing(role, {
      onDevices: (devices) => setPairing((p) => p && { ...p, devices }),
      onConfirm: (confirm) => setPairing((p) => p && { ...p, confirm, message: '', waiting: false }),
      onStatus: (message) => setPairing((p) => p && { ...p, message, waiting: true }),
      onDone: (r) => {
        ctl.current = null;
        void reload();
        setPairing(null);
        if (r.ok && !intro.seen) setIntroVisible(true); // 初回だけ「次にやること」を出す
        else Alert.alert(r.ok ? 'ペアリング完了' : 'ペアリング失敗', r.ok ? `${r.pair.peerName} とペアになりました。以後は自動で接続します。` : r.error);
      },
    });
  };
  const cancelPairing = () => { ctl.current?.cancel(); ctl.current = null; setPairing(null); };

  const chooseRole = async (r: 'host' | 'guest') => { await tether.setDeviceRole(r); setDeviceRole(r); };
  const changeRole = () => Alert.alert('役割を変更', '親機・子機の役割を入れ替えます。ペアは作り直しが必要です。', [
    { text: 'キャンセル', style: 'cancel' },
    { text: '変更する', onPress: () => run((async () => { for (const p of await tether.pairs()) await tether.removePair(p.peerId); await reload(); await tether.setDeviceRole(deviceRole === 'host' ? 'guest' : 'host'); setDeviceRole(await tether.deviceRole()); })()) },
  ]);

  if (deviceRole === undefined) return <View style={styles.root} />;
  if (deviceRole === null && !introDone) return <Intro onDone={() => setIntroDone(true)} />;
  if (deviceRole === null) {
    return (
      <View style={styles.root}>
        <View style={styles.appBar}><Text style={styles.title}>この端末の役割を選んでください</Text></View>
        <View style={styles.content}>
          <Text style={styles.secondary}>一度選ぶと、以後はずっとこの役割で動きます(あとから変更もできます)。</Text>
          <RoleCard icon="📶" title="親機" body="携帯回線を持つ端末。回線を子機に貸します。この端末の通信量と電池を使います。" onPress={() => run(chooseRole('host'))} />
          <RoleCard icon="📱" title="子機" body="回線を持たない端末。親機の回線でインターネットに出ます。親機の近くで使います。" onPress={() => run(chooseRole('guest'))} />
        </View>
        <StatusBar style="dark" />
      </View>
    );
  }

  const roleText = s.role ? (s.role === 'host' ? '親機(回線を共有)' : '子機(親機の回線を借りる)') : `未開始(この端末は${s.autoRole === 'host' ? '親機' : '子機'}になります)`;
  const stateRows: [string, string][] = [
    ['役割', roleText],
    ['リンク', `${LINK_TEXT[s.link]}${s.pending ? `(未送達 ${s.pending} 件)` : ''}`],
    ...(s.role === 'host' ? [['回線の共有', `${SHARE_TEXT[s.share]}${s.shareMethod ? `(${s.shareMethod})` : ''}${s.peerReach ? ` / 子機の到達 ${s.peerReach.ok ? 'OK' : 'NG'}` : ''}`] as [string, string]] : []),
    ...(s.role === 'guest' ? [['VPN', VPN_TEXT[s.vpn]] as [string, string]] : []),
  ];

  const sum = s.started ? linkSummary(s.link === 'stopped' ? 'idle' : (s.link as LinkPhase), s.error) : null;

  return (
    <View style={styles.root}>
      <PostPairIntro visible={introVisible} onDone={() => { intro.markSeen(); setIntroVisible(false); }} />
      <View style={styles.appBar}><Text style={styles.title}>Tether Auto Connect</Text></View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.label}>この端末</Text>
        <View style={[styles.card, styles.listRow]}>
          <Text style={{ fontSize: 32 }}>{deviceRole === 'host' ? '📶' : '📱'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.primary}>{deviceRole === 'host' ? '親機' : '子機'} · {identity ? identity.name : '…'}</Text>
            <Text style={styles.secondary}>{deviceRole === 'host' ? '回線を子機に貸します' : '親機の回線を借ります'}</Text>
          </View>
          <Btn kind="text" title="変更" onPress={changeRole} />
        </View>

        <Text style={styles.label}>ペア</Text>
        <View style={styles.card}>
          {pairs.length === 0 && <Text style={styles.secondary}>まだありません。「ペアを追加」で近くの端末と組みます。</Text>}
          {pairs.map((p, i) => (
            <View key={p.peerId} style={[styles.listRow, i > 0 && styles.divider]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.primary}>{p.peerName}</Text>
                <Text style={styles.secondary}>{p.role === 'host' ? '親機として使う' : p.role === 'guest' ? '子機として使う' : p.peerId}</Text>
              </View>
              <Btn kind="text" danger title="削除" onPress={() => Alert.alert('ペアを削除', `${p.peerName} とのペアを削除します。共有コードも破棄されます。`, [
                { text: 'キャンセル', style: 'cancel' },
                { text: '削除', style: 'destructive', onPress: () => run(tether.removePair(p.peerId).then(reload)) },
              ])} />
            </View>
          ))}
          <Btn kind="tonal" title={deviceRole === 'host' ? 'ペアを追加(子機を待つ)' : 'ペアを追加(親機を探す)'} onPress={() => run(addPair(deviceRole))} />
        </View>

        <Text style={styles.label}>状態</Text>
        <View style={styles.card}>
          {sum && (
            <View style={[styles.row, styles.badge, sum.tone === 'ok' ? styles.badgeOk : styles.badgeWarn]} accessibilityLabel={sum.text}>
              {s.link === 'connecting' && <ActivityIndicator size="small" color={C.primary} />}
              <Text style={[styles.primary, { flex: 1 }]}>{sum.text}</Text>
            </View>
          )}
          {stateRows.map(([k, v], i) => (
            <View key={k} style={[styles.listRow, i > 0 && styles.divider]}>
              <Text style={[styles.secondary, { width: 96 }]}>{k}</Text>
              <Text style={[styles.primary, { flex: 1 }]}>{v}</Text>
            </View>
          ))}
          {s.error && <Text style={styles.err}>{s.error}</Text>}
        </View>

        <View style={styles.actions}>
          {s.started ? (
            <>
              <Btn kind="filled" title="停止" onPress={() => tether.stop()} />
              {s.role === 'guest' && (s.vpn === 'held'
                ? <Btn kind="tonal" title="VPN を再開" onPress={() => run(tether.resumeVpn())} />
                : <Btn kind="tonal" title="VPN を止める(通信できないとき)" onPress={() => tether.stopVpn()} />)}
            </>
          ) : (
            <Btn kind="filled" title="開始(役割は自動)" disabled={!pairs.length} onPress={() => run(tether.start())} />
          )}
        </View>

        <Text style={styles.label}>ログ</Text>
        <View style={styles.card}>
          {log.map((l, i) => <Text key={i} style={styles.logLine}>{l}</Text>)}
        </View>

        <DiagnosticsPanel tether={tether} />
      </ScrollView>

      <Modal visible={!!pairing} transparent animationType="fade" statusBarTranslucent onRequestClose={cancelPairing}>
        <View style={styles.scrim}>
          <View style={styles.dialog}>
            {pairing?.confirm ? (
              <>
                <Text style={styles.dialogTitle}>この数字は一致していますか?</Text>
                <Text style={styles.secondary}>{pairing.confirm.peerName} の画面にも同じ数字が出ています。</Text>
                <Text style={styles.digits}>{pairing.confirm.digits}</Text>
                {pairing.waiting && <View style={styles.row}><ActivityIndicator color={C.primary} /><Text style={styles.primary}>{pairing.message}</Text></View>}
                <View style={styles.dialogActions}>
                  <Btn kind="text" title="やめる" onPress={cancelPairing} />
                  {!pairing.waiting && <Btn kind="text" danger title="一致しない" onPress={() => pairing.confirm!.reject()} />}
                  {!pairing.waiting && <Btn kind="text" title="一致する" onPress={() => pairing.confirm!.accept()} />}
                </View>
              </>
            ) : (
              <>
                <Text style={styles.dialogTitle}>{pairing?.role === 'host' ? '子機からの接続を待っています' : '親機を探しています'}</Text>
                <View style={styles.row}>
                  <ActivityIndicator color={C.primary} />
                  <Text style={[styles.secondary, { flex: 1 }]}>
                    {pairing?.waiting ? pairing.message : pairing?.role === 'host' ? '子機にする端末で「この端末を子機にする」を押してください' : '親機にする端末で「この端末を親機にする」を押してください'}
                  </Text>
                </View>
                {pairing?.role === 'guest' && (pairing.devices.length ? (
                  <>
                    <Text style={styles.secondary}>見つかった親機(タップで接続を要求)</Text>
                    {pairing.devices.map((d) => (
                      <Pressable key={d.endpointId} android_ripple={{ color: C.ripple }} style={[styles.listRow, styles.deviceRow]} onPress={() => ctl.current?.connectTo(d.endpointId)}>
                        <Text style={{ fontSize: 28 }}>📱</Text>
                        <Text style={[styles.primary, { flex: 1 }]}>{d.label}</Text>
                        <Text style={{ color: C.primary, fontSize: 16, fontWeight: '600' }}>接続</Text>
                      </Pressable>
                    ))}
                  </>
                ) : <Text style={styles.secondary}>まだ見つかっていません…</Text>)}
                <View style={styles.dialogActions}>
                  <Btn kind="text" title="キャンセル" onPress={cancelPairing} />
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
      <StatusBar style="dark" />
    </View>
  );
}

// Material 3(ライト)に寄せた配色と部品。外部ライブラリは使わない。
const C = { primary: '#1a6b4b', onPrimary: '#fff', container: '#cfe9dc', surface: '#fbfdf9', card: '#eef3ee', text: '#191c1a', sub: '#5a625d', line: '#d6ddd7', error: '#ba1a1a', ripple: 'rgba(26,107,75,0.16)' };

const SLIDES = [
  { icon: '🔁', title: 'テザリング、毎回つなぎ直していませんか', body: 'スマホを2台お持ちの方へ。\n勝手に切れる。毎回手でオンにする。つなぐたびに確認が出る。\nそんな手間を、なくします。' },
  { icon: '📶 ⇄ 📱', title: '一度ペアにすれば、あとは自動', body: '回線を持つ「親機」と、持たない「子機」。\n一度ペアにするだけで、近づけば自動でつながります。' },
  { icon: '📶', title: '親機とは', body: '携帯回線(SIM)を持つ端末です。\nこの端末の回線を、近くの子機に貸します。\n子機の通信量は、親機の契約から使われ、電池も消費します。\n子機が近くにいる間は、アプリを動かしたままにしてください。' },
  { icon: '📱', title: '子機とは', body: '2台目のスマホ(回線を持たない、または使いたくない端末)です。\n親機の回線でインターネットに出ます。\n子機が回線を持っていても、役割は自分で選べます。' },
  { icon: '🚶‍♂️↩️', title: '離れても、戻れば自動で復旧', body: '距離で切れても、戻れば元どおり。\n切れている間は子機の通信を素に戻すので、止まったままになりません。' },
  { icon: '🔒', title: '安全のために', body: 'ペアごとに違う暗号の鍵を作り、通信内容は保存しません。\n連絡先や画面の内容は読み取りません。' },
];

/** 初回だけ出す、機能説明のカルーセル(横スワイプ)。最後に役割の選択へ進む */
function Intro({ onDone }: { onDone(): void }) {
  const { width } = useWindowDimensions();
  const ref = useRef<ScrollViewInstance>(null);
  const [page, setPage] = useState(0);
  const last = page === SLIDES.length - 1;
  const go = (i: number) => { ref.current?.scrollTo({ x: i * width, animated: true }); setPage(i); };
  return (
    <View style={styles.root}>
      <View style={styles.introTop}>{!last && <Btn kind="text" title="スキップ" onPress={onDone} />}</View>
      <ScrollView ref={ref} horizontal pagingEnabled showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / width))}>
        {SLIDES.map((sl) => (
          <View key={sl.title} style={[styles.slide, { width }]}>
            <View style={styles.hero}><Text style={styles.heroIcon}>{sl.icon}</Text></View>
            <Text style={styles.slideTitle}>{sl.title}</Text>
            <Text style={styles.slideBody}>{sl.body}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={styles.dots}>
        {SLIDES.map((_, i) => <View key={i} style={[styles.dot, i === page && styles.dotOn]} />)}
      </View>
      <View style={styles.introBottom}>
        <Btn kind="filled" title={last ? 'はじめる' : '次へ'} onPress={() => (last ? onDone() : go(page + 1))} />
      </View>
      <StatusBar style="dark" />
    </View>
  );
}

function RoleCard({ icon, title, body, onPress }: { icon: string; title: string; body: string; onPress(): void }) {
  return (
    <Pressable onPress={onPress} android_ripple={{ color: C.ripple }} style={[styles.card, styles.roleCard]}>
      <Text style={{ fontSize: 44 }}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.dialogTitle, { color: C.primary }]}>{title}</Text>
        <Text style={styles.secondary}>{body}</Text>
      </View>
    </Pressable>
  );
}

function Btn({ title, onPress, kind, danger, disabled }: { title: string; onPress(): void; kind: 'filled' | 'tonal' | 'text'; danger?: boolean; disabled?: boolean }) {
  const bg = kind === 'filled' ? C.primary : kind === 'tonal' ? C.container : 'transparent';
  const fg = kind === 'filled' ? C.onPrimary : danger ? C.error : kind === 'tonal' ? '#0b2e20' : C.primary;
  return (
    <Pressable onPress={onPress} disabled={disabled} android_ripple={{ color: kind === 'filled' ? 'rgba(255,255,255,0.25)' : C.ripple }}
      style={[styles.btn, { backgroundColor: bg, opacity: disabled ? 0.38 : 1 }, kind === 'text' && styles.btnText]}>
      <Text style={{ color: fg, fontSize: 17, fontWeight: '600', letterSpacing: 0.1 }}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.surface },
  appBar: { paddingTop: 48, paddingBottom: 12, paddingHorizontal: 20, backgroundColor: C.surface },
  title: { fontSize: 28, color: C.text },
  content: { padding: 16, paddingTop: 4, gap: 8, paddingBottom: 40 },
  label: { fontSize: 15, color: C.primary, fontWeight: '600', marginTop: 12, marginLeft: 4 },
  card: { backgroundColor: C.card, borderRadius: 20, padding: 18, gap: 10 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line },
  primary: { fontSize: 18, color: C.text },
  secondary: { fontSize: 15, color: C.sub },
  badge: { padding: 12, borderRadius: 8, marginBottom: 6 },
  badgeOk: { backgroundColor: '#dff3e6' },
  badgeWarn: { backgroundColor: '#fff3d6' },
  err: { color: C.error, fontSize: 15 },
  actions: { gap: 8, marginTop: 16 },
  btn: { height: 52, borderRadius: 26, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  btnText: { paddingHorizontal: 14 },
  logLine: { fontSize: 12, fontFamily: 'monospace', color: C.sub },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.32)', justifyContent: 'center', padding: 28 },
  dialog: { backgroundColor: C.surface, borderRadius: 28, padding: 24, gap: 14 },
  dialogTitle: { fontSize: 26, color: C.text },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 4, marginTop: 6 },
  deviceRow: { backgroundColor: C.card, borderRadius: 16, paddingHorizontal: 14, overflow: 'hidden' },
  introTop: { height: 96, paddingTop: 44, paddingHorizontal: 12, alignItems: 'flex-end' },
  slide: { paddingHorizontal: 32, alignItems: 'center', justifyContent: 'center', gap: 20 },
  hero: { width: 220, height: 220, borderRadius: 110, backgroundColor: C.container, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  heroIcon: { fontSize: 56 },
  slideTitle: { fontSize: 26, color: C.text, textAlign: 'center', fontWeight: '500' },
  slideBody: { fontSize: 17, color: C.sub, textAlign: 'center', lineHeight: 27 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingVertical: 16 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.line },
  dotOn: { width: 24, backgroundColor: C.primary },
  introBottom: { paddingHorizontal: 24, paddingBottom: 36 },
  roleCard: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 22, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  digits: { fontSize: 56, fontWeight: '500', letterSpacing: 8, color: C.primary, textAlign: 'center', paddingVertical: 8 },
});
