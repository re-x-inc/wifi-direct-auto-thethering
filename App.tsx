import * as Crypto from 'expo-crypto';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Button, PermissionsAndroid, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import Hotspot from './modules/hotspot';
import KeepAlive from './modules/keep-alive';
import VpnTunnel from './modules/vpn-tunnel';
import { DEV_ID, DEV_SECRET, nearbyApi } from './src/devLink';
import { createLink } from './src/link/session';
import { LinkSupervisor } from './src/link/supervisor';

const PERMS = [
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_ADVERTISE',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.NEARBY_WIFI_DEVICES',
  'android.permission.POST_NOTIFICATIONS',
] as any[];

const hhmmss = () => new Date().toTimeString().slice(0, 8);

// Fast Refresh で App が作り直されても、古いリンクが残って二重に動かないよう、モジュール単位で1本だけ持つ
let startingLink = false;
let activeLink: LinkSupervisor | null = null;
let activeTicker: ReturnType<typeof setInterval> | null = null;

export default function App() {
  // --- 端末間リンク(実機テスト) ---
  const [role, setRole] = useState<'host' | 'guest' | null>(null);
  const [state, setState] = useState('停止');
  // 親機 = セルラー回線がある端末(子機にもなれる)。子機 = 回線がない端末
  const [cellular, setCellular] = useState(false);
  useEffect(() => { try { setCellular(Hotspot.hasCellular()); } catch {} }, []);
  const [log, setLog] = useState<string[]>([]);
  const shareMsg = useRef<Record<string, unknown> | null>(null);
  const link = useRef<LinkSupervisor | null>(null);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const push = (s: string) => {
    console.log('[DH] ' + s);
    setLog((l) => [`${hhmmss()} ${s}`, ...l].slice(0, 60));
  };

  // 子機: 起動時に残った VPN を止め、Wi-Fi Direct が切れたら VPN とプロセスの固定を外す(全通信を飲み込んだままにしない)
  useEffect(() => {
    try { VpnTunnel.stop(); Hotspot.unbindProcess(); } catch {}
    const sub = Hotspot.addListener('onWifiLost', () => {
      try { VpnTunnel.stop(); Hotspot.unbindProcess(); } catch {}
      push('Wi-Fi Direct 切断 → VPN を停止');
    });
    return () => sub.remove();
  }, []);

  const stopLink = () => {
    activeLink?.stop(); activeLink = null;
    if (activeTicker) clearInterval(activeTicker);
    activeTicker = null;
    if (ticker.current) clearInterval(ticker.current);
    ticker.current = null;
    link.current?.stop();
    link.current = null;
    KeepAlive.stop();
    setRole(null);
  };

  const startLink = async (r: 'host' | 'guest') => {
    if (Platform.OS !== 'android') return;
    // 権限ダイアログの await 中に二重で押されても、リンクが2本走らないよう、同期的に弾く
    if (startingLink) return;
    startingLink = true;
    try { await startLinkInner(r); } finally { startingLink = false; }
  };
  const startLinkInner = async (r: 'host' | 'guest') => {
    activeLink?.stop();
    if (activeTicker) clearInterval(activeTicker);
    activeLink = null; activeTicker = null;
    if (!DEV_SECRET) { push('EXPO_PUBLIC_DEV_SECRET が未設定です(README 参照)'); return; }
    const res = await PermissionsAndroid.requestMultiple(PERMS);
    push('権限: ' + Object.entries(res).map(([k, v]) => `${k.split('.').pop()}=${v === 'granted' ? 'OK' : v}`).join(' '));
    KeepAlive.start();
    const peer = r === 'host' ? DEV_ID.guest : DEV_ID.host;
    const sup = createLink(
      nearbyApi,
      { role: r, selfId: DEV_ID[r], pair: { peerId: peer, secret: DEV_SECRET }, connectTimeoutMs: 30000 },
      (body) => {
        if ((body as any)?.kind === 'wifi' && r === 'guest') {
          void joinFromHost(body as any);
        } else if ((body as any)?.kind === 'wifi-result') {
          const b = body as any;
          push(`子機の到達確認: ${b.ok ? `OK ${b.rttMs}ms (gw ${b.gateway})` : `NG ${b.error ?? ''}`}`);
        } else if ((body as any)?.kind !== 'tick') push('受信 ' + JSON.stringify(body));
      },
    );
    sup.onState = (s, n) => {
      setState(s === 'connecting' ? `接続中(${n + 1}回目)` : s === 'connected' ? '接続済み' : s === 'waiting' ? '再試行待ち' : '停止');
      push('状態: ' + s);
      // 親機: つながり直したら、共有中の接続情報を再送する(Wi-Fi Direct は作り直さず、子機は同じ SSID を再利用する)
      if (s === 'connected' && r === 'host' && shareMsg.current) {
        sup.send(shareMsg.current, { key: 'wifi', ttlMs: 60000 });
        push('再接続: 接続情報を再送');
      }
    };
    link.current = sup;
    activeLink = sup;
    setRole(r);
    void sup.run();
    if (r === 'host') {
      let n = 0;
      ticker.current = setInterval(() => sup.send({ kind: 'tick', n: ++n }, { ttlMs: 0 }), 3000);
      activeTicker = ticker.current;
    }
  };

  // 親機: LocalOnlyHotspot を試し、だめなら Wi-Fi Direct に切り替える。接続情報は Nearby 経由で子機へ送る
  const sharing = useRef(false);
  const startShare = async (m: 'lohs' | 'direct') => {
    // LOHS の要求は OS 内で長く待たされることがある(実測 69 秒)。重ねて押すと「active request」で失敗するため弾く
    if (sharing.current) { push('共有を準備中です。しばらくお待ちください'); return; }
    sharing.current = true;
    try { await doShare(m); } finally { sharing.current = false; }
  };
  const doShare = async (want: 'lohs' | 'direct') => {
    // 押し直しても失敗しないよう、前回の共有を先に止める。
    // Wi-Fi Direct のグループ(p2p0)が残っていると、この端末では LOHS の AP を作れないため、消えるのを待つ。
    Hotspot.stopSocks();
    Hotspot.stopHotspot();
    await Hotspot.stopDirect();
    await new Promise((r) => setTimeout(r, 1500));
    // 子機は承認済みの SSID が見えた瞬間に自動参加して到達確認をする。待たせて拒否されないよう、ポートを先に開けておく
    try { Hotspot.startEcho(9000); } catch (e: any) { push('エコー起動失敗: ' + (e?.message ?? e)); }
    // SOCKS5(子機の回線用)。認証情報は接続ごとに作り、Nearby の暗号化された経路でだけ子機へ渡す。
    const hex = (n: number) => Array.from(Crypto.getRandomBytes(n), (b) => b.toString(16).padStart(2, '0')).join('');
    const socks = { port: 1080, user: 'u' + hex(4), pass: hex(12) };
    try {
      const { network } = await Hotspot.startSocks(socks.port, socks.user, socks.pass);
      push(`SOCKS5 起動 (出口: ${network === 'cellular' ? '携帯回線' : '既定の回線'})`);
      const t = await Hotspot.socksSelfTest(socks.port, socks.user, socks.pass);
      push(`SOCKS 自己診断: ${t.ok ? `OK ${t.line}` : `NG ${t.error ?? t.line}`}`);
    } catch (e: any) {
      push('SOCKS 失敗: ' + (e?.message ?? e));
    }
    let method = want === 'lohs' ? 'LocalOnlyHotspot' : 'WifiDirect';
    let cred: { ssid: string; passphrase: string } | null = null;
    if (want === 'lohs') {
      for (let i = 1; i <= 3 && !cred; i++) {
        const t0 = Date.now();
        try {
          cred = await Hotspot.startHotspot();
          push(`LocalOnlyHotspot 成功(${i}回目, ${Date.now() - t0}ms)`);
        } catch (e: any) {
          push(`LocalOnlyHotspot 失敗 ${i}/3 (${Date.now() - t0}ms): ${e?.message ?? e}`);
          if (i < 3) await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (!cred) return;
    } else {
      // 実験: SSID・パスフレーズ・チャンネル(2.4GHz ch6)を毎回同じにする。共有コードから導く(開発用の固定コード)
      const h1 = nearbyApi.hmac(DEV_SECRET, 'direct-ssid');
      const h2 = nearbyApi.hmac(DEV_SECRET, 'direct-pass');
      const name = 'DIRECT-dh-' + h1.slice(0, 4);
      const pass = h2.slice(0, 12);
      const t0 = Date.now();
      try {
        cred = await Hotspot.startDirect(name, pass, 2437);
        push(`Wi-Fi Direct 成功(${Date.now() - t0}ms, 固定 ch6)`);
      } catch (e: any) {
        push(`Wi-Fi Direct 失敗(${Date.now() - t0}ms): ${e?.message ?? e}`);
        return;
      }
    }
    push(`${method} 起動 ssid=${cred.ssid}`);
    shareMsg.current = { kind: 'wifi', method, ssid: cred.ssid, pass: cred.passphrase, port: 9000, socks };
    link.current?.send(shareMsg.current, { key: 'wifi', ttlMs: 60000 });
    push('接続情報を子機へ送信');
  };

  // 子機: 受け取った接続情報で参加し、親機のポートへ到達できるか確かめて結果を返す
  const joinFromHost = async (m: { ssid: string; pass: string; port: number; socks?: { port: number; user: string; pass: string } }) => {
    push(`接続情報を受信 ssid=${m.ssid} → 参加(端末の承認ダイアログが出たら許可)`);
    try {
      // 固定 SSID なら、承認ダイアログで「常に許可」を選んだ後は OS が覚える。Suggestion は同じ SSID と競合しうるので使わない
      const { gateway } = await Hotspot.joinWifi(m.ssid, m.pass);
      if (m.ssid) push(`参加 ${m.ssid}`);
      push(`参加 gateway=${gateway}`);
      // 親機のポートが開くのが少し遅れることがあるので、2秒おきに最大10回まで再試行する
      let res = await Hotspot.probe(gateway, m.port);
      for (let i = 1; i < 10 && !res.ok; i++) {
        push(`到達確認 NG(${i}/10): ${res.error}`);
        await new Promise((r) => setTimeout(r, 2000));
        res = await Hotspot.probe(gateway, m.port);
      }
      push(`到達確認 ${res.ok ? `OK ${res.rttMs}ms` : `NG ${res.error}`}`);
      link.current?.send({ kind: 'wifi-result', gateway, ...res }, { ttlMs: 60000 });
      if (res.ok && m.socks) await startVpn(gateway, m.socks);
    } catch (e: any) {
      push('参加失敗: ' + (e?.message ?? e));
      link.current?.send({ kind: 'wifi-result', ok: false, error: String(e?.message ?? e) }, { ttlMs: 60000 });
    }
  };

  // 子機: 全通信を親機の SOCKS5 へ流す VPN を張る(初回は端末の VPN 許可ダイアログが出る)
  const startVpn = async (gateway: string, socks: { port: number; user: string; pass: string }) => {
    try {
      for (let i = 0; i < 60 && !VpnTunnel.prepare(); i++) {
        if (i === 0) push('VPN の許可ダイアログで「OK」を押してください');
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!Hotspot.bindToJoined()) push('Wi-Fi への固定に失敗');
      VpnTunnel.start(gateway, socks.port, socks.user, socks.pass);
      await new Promise((r) => setTimeout(r, 1500));
      const st = VpnTunnel.status();
      push(`VPN ${st.running ? '起動' : '失敗'}${st.error ? ' ' + st.error : ''}`);
    } catch (e: any) {
      push('VPN 失敗: ' + (e?.message ?? e));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.h}>Tether Auto Connect</Text>

      <Text style={styles.sec}>端末間リンク(開発版)</Text>
      <Text>状態: {state}{role ? ` / ${role === 'host' ? '親機' : '子機'}` : ''}</Text>
      {!role ? (
        <>
          <Text>セルラー回線: {cellular ? 'あり → 親機になります' : 'なし → 子機になります'}</Text>
          <Button title={`開始(自動: ${cellular ? '親機' : '子機'})`} onPress={() => startLink(cellular ? 'host' : 'guest')} />
          {cellular && <Button title="子機として使う(別の親機の回線を借りる)" onPress={() => startLink('guest')} />}
          <Button title="回線の有無を再判定" onPress={() => setCellular(Hotspot.hasCellular())} />
        </>
      ) : (
        <>
          {role === 'host' && <Button title="共有: LOHS(毎回SSIDが変わる)" onPress={() => startShare('lohs')} />}
          {role === 'host' && <Button title="共有: Wi-Fi Direct(SSID固定・実験)" onPress={() => startShare('direct')} />}
          <Button title="停止" onPress={stopLink} />
          <Button title="VPN停止(通信が止まったとき)" onPress={() => { VpnTunnel.stop(); Hotspot.unbindProcess(); push('VPN 停止'); }} />
        </>
      )}
      <View style={styles.log}>
        {log.map((l, i) => (
          <Text key={i} style={styles.logLine}>{l}</Text>
        ))}
      </View>

      <StatusBar style="dark" />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#fff', padding: 24, paddingTop: 64, gap: 10 },
  h: { fontSize: 24, fontWeight: '700' },
  sec: { fontSize: 16, fontWeight: '700', marginTop: 16 },
  log: { backgroundColor: '#f3f3f3', padding: 8, minHeight: 120 },
  logLine: { fontSize: 11, fontFamily: 'monospace' },
});
