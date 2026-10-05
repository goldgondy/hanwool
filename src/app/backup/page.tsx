"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { collectBackup, decryptBackup, encryptBackup, lastBackupAt, markBackedUp, restoreBackup, summarize, type BackupPayload } from "@/lib/backup";
import { formatDateTime } from "@/lib/format";
import { btn, Callout, Card, ErrorText, inputCls, PageHeader } from "@/components/ui";

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function BackupCard() {
  const last = useLiveQuery(lastBackupAt, []);
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const tooShort = pass.length < 8;
  const mismatch = pass !== confirm;

  async function run() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const payload = await collectBackup();
      const file = await encryptBackup(payload, pass);
      const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
      download(file, `btax-backup-${day}.btax`);
      await markBackedUp();
      const s = summarize(payload);
      setDone(`계정 ${s.sources}개, 거래 기록 ${s.ledger}건, 분류 결정 ${s.decisions}건, 보유 기록 ${s.snapshots}개를 백업했습니다.`);
      setPass("");
      setConfirm("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4">
      <div className="space-y-1">
        <h2 className="font-semibold">백업 파일 내려받기</h2>
        <p className="text-xs leading-5 text-stone-500">
          연결한 계정, 거래 기록, 직접 고른 분류, 잔고 대사 결과, 보유 기록을 모두 하나의 파일(.btax)로 내려받습니다. 파일은 아래 백업 비밀번호로
          암호화되어, 비밀번호 없이는 열 수 없습니다. 클라우드 드라이브나 USB 등 안전한 곳에 보관하세요.
        </p>
        <p className="text-xs text-stone-500">마지막 백업: {last ? formatDateTime(last) : "아직 없음"}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <input className={`${inputCls} sm:w-56`} type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="백업 비밀번호 (8자 이상)" autoComplete="new-password" />
        <input className={`${inputCls} sm:w-56`} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="비밀번호 확인" autoComplete="new-password" />
        <button className={btn()} disabled={busy || tooShort || mismatch} onClick={run}>
          {busy ? "만드는 중…" : "백업 내려받기"}
        </button>
      </div>
      <p className="text-xs text-amber-700 dark:text-amber-400">백업 비밀번호를 잊으면 파일을 열 수 없습니다. 서비스에서도 복구해 드릴 수 없습니다.</p>
      {done && <Callout tone="success">{done}</Callout>}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

function RestoreCard() {
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [pass, setPass] = useState("");
  const [payload, setPayload] = useState<BackupPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [sure, setSure] = useState(false);

  async function open() {
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      setPayload(await decryptBackup(text, pass));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!payload) return;
    setBusy(true);
    setError(null);
    try {
      await restoreBackup(payload);
      setDone(true);
      setPayload(null);
      setText(null);
      setPass("");
      setSure(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const s = payload ? summarize(payload) : null;

  return (
    <Card className="space-y-4">
      <div className="space-y-1">
        <h2 className="font-semibold">백업에서 복원하기</h2>
        <p className="text-xs leading-5 text-stone-500">
          새 기기·새 브라우저로 옮기거나 데이터가 지워졌을 때 씁니다. 복원하면 <b>지금 이 브라우저에 있는 데이터는 모두 백업 내용으로 바뀝니다.</b>
        </p>
      </div>
      <input
        type="file"
        accept=".btax,application/json"
        className="block w-full text-sm"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          setPayload(null);
          setDone(false);
          setError(null);
          setText(f ? await f.text() : null);
          setFileName(f?.name ?? "");
        }}
      />
      {text && !payload && (
        <div className="flex flex-wrap gap-2">
          <input className={`${inputCls} sm:w-64`} type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={`${fileName}의 백업 비밀번호`} autoComplete="current-password" />
          <button className={btn("secondary")} disabled={busy || !pass} onClick={open}>
            {busy ? "여는 중…" : "열기"}
          </button>
        </div>
      )}
      {s && (
        <div className="space-y-3 rounded-xl bg-stone-50 p-4 text-sm dark:bg-stone-800/40">
          <p>
            <b>{formatDateTime(s.createdAt)}</b> 백업 · 계정 {s.sources}개 · 거래 기록 {s.ledger}건 · 분류 결정 {s.decisions}건 · 보유 기록 {s.snapshots}개
          </p>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
            지금 이 브라우저의 데이터를 지우고 이 백업으로 바꾸는 것에 동의합니다
          </label>
          <button className={btn("danger")} disabled={busy || !sure} onClick={restore}>
            {busy ? "복원 중…" : "복원하기"}
          </button>
        </div>
      )}
      {done && (
        <Callout tone="success" title="복원했습니다">
          거래소 API 키를 쓰려면 왼쪽 아래에서 <b>백업할 때의 거래소 키 비밀번호</b>로 잠금을 해제하세요.
        </Callout>
      )}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

export default function BackupPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="백업·복원"
        description="B택스는 거래 기록과 키를 서버가 아닌 이 브라우저에만 저장합니다. 그래서 브라우저 데이터를 지우거나 기기를 바꾸면 사라집니다. 정기적으로 백업 파일을 내려받아 두세요. 특히 거래소가 오래된 기록을 지우기 전에 가져온 내역은 다시 받을 수 없습니다."
      />
      <BackupCard />
      <RestoreCard />
    </div>
  );
}
