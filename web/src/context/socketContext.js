import { createContext, useContext } from "react";

// Port rule matches daemon: numeric account id. Default account alpha → :30001.
// Non-numeric ids fall back to 30001. Override with ?account=alpha or REACT_APP_API_URL.
function resolveApiUrl() {
	if (process.env.REACT_APP_API_URL) return process.env.REACT_APP_API_URL;
	try {
		const params = new URLSearchParams(window.location.search);
		const account = params.get('account') || localStorage.getItem('whatsealAccount') || 'alpha';
		if (/^\d+$/.test(account)) {
			const n = parseInt(account, 10);
			const port = n >= 1024 && n <= 65535 ? n : n >= 1 && n <= 1023 ? 10000 + n : 30001;
			return `http://localhost:${port}`;
		}
	} catch (_) { /* ignore */ }
	return 'http://localhost:30001';
}

const API_URL = resolveApiUrl();

// Mock socket-like API object for compatibility
const api = {
	on: () => {},
	emit: () => {},
	baseUrl: API_URL,
	async fetchChats() {
		const res = await fetch(`${API_URL}/api/chats`);
		return res.json();
	},
	async fetchMessages(chatId, limit = 50) {
		const res = await fetch(`${API_URL}/api/messages/${encodeURIComponent(chatId)}?limit=${limit}`);
		return res.json();
	},
	async sendMessage(chatId, text) {
		const res = await fetch(`${API_URL}/api/send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ chatId, text })
		});
		return res.json();
	}
};

const SocketContext = createContext();

const useSocketContext = () => useContext(SocketContext);

const SocketProvider = ({ children }) => {
	return (
		<SocketContext.Provider value={api}>{children}</SocketContext.Provider>
	);
};

export { useSocketContext, SocketProvider };
