import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

// 任何渲染期异常都不允许变成白屏
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[wordvault] 渲染异常', error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="crash">
          <h2>界面出错了</h2>
          <p className="crash-msg">{String(this.state.error.message || this.state.error)}</p>
          <div className="row">
            <button className="btn primary" onClick={() => this.setState({ error: null })}>重试渲染</button>
            <button className="btn" onClick={() => window.location.reload()}>刷新页面</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
