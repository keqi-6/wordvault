import { useWV } from '../store';

export default function BackendBanner() {
  const backend = useWV((s) => s.backend);
  const msg = useWV((s) => s.backendMsg);
  const reloadAll = useWV((s) => s.reloadAll);
  if (backend !== 'down') return null;
  return (
    <div className="banner">
      <span className="banner-dot" />
      <b>后端未启动</b>
      <span className="banner-msg">{msg || '无法连接 http://127.0.0.1:8787'}</span>
      <span className="banner-hint">请在 server 目录运行 npm start，并确保数据管线已生成数据库</span>
      <button className="btn btn-sm" onClick={() => void reloadAll()}>重连</button>
    </div>
  );
}
