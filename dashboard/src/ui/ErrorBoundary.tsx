import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex items-center justify-center min-h-[400px] p-8">
        <div className="max-w-md w-full rounded-lg border p-6 text-center"
          style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}>
          <div className="mx-auto mb-4 w-12 h-12 rounded-full flex items-center justify-center"
            style={{ background: 'var(--accent-subtle)' }}>
            <AlertTriangle size={24} style={{ color: 'var(--danger)' }} />
          </div>
          <h3 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            Something went wrong
          </h3>
          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={this.handleReset}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm cursor-pointer transition-colors border"
              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
            >
              Try Again
            </button>
            <button
              onClick={this.handleReload}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm cursor-pointer transition-colors"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              <RefreshCw size={14} />
              Reload Page
            </button>
          </div>
          {this.state.error?.stack && (
            <details className="mt-4 text-left">
              <summary className="text-xs cursor-pointer" style={{ color: 'var(--text-muted)' }}>
                Stack trace
              </summary>
              <pre className="text-[10px] mt-2 p-2 rounded overflow-auto max-h-48"
                style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>
                {this.state.error.stack}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
