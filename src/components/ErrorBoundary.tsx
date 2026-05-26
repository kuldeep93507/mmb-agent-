import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State { hasError: boolean; error: string; }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: '' };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen bg-gray-950 text-white p-8">
          <div className="text-6xl mb-4">⚠️</div>
          <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
          <p className="text-gray-400 text-sm mb-4 max-w-md text-center">{this.state.error}</p>
          <button onClick={() => { this.setState({ hasError: false, error: '' }); window.location.reload(); }}
            className="px-6 py-3 bg-red-600 hover:bg-red-500 rounded-xl text-sm font-semibold transition-all">
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
