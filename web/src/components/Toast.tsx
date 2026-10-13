import { useEffect } from 'react';
import { useWV } from '../store';

// 轻提示：3.6s 后自动消失
export default function Toast() {
  const toast = useWV((s) => s.toast);
  const setToast = useWV((s) => s.setToast);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(t);
  }, [toast, setToast]);
  if (!toast) return null;
  return (
    <div className="toast" role="status" onClick={() => setToast(null)}>
      {toast}
    </div>
  );
}
