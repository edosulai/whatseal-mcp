import { createContext, useContext } from "react";

// Port rule matches daemon: 30000 + last 4 account digits.
// alpha → 30001, beta → 30002. Override with ?account=alpha or REACT_APP_API_URL.
function resolveApiUrl() {
	if (process.env.REACT_APP_API_URL) return process.env.REACT_APP_API_URL;
	try {
		const params = new URLSearchParams(window.location.search);
		const account = params.get('account') || localStorage.getItem('whatsealAccount') || 'alpha';
		const digits = String(account).replace(/\D/g, '') || 'alpha';
		const last4 = digits.slice(-4).padStart(4, '0');
		const port = 30000 + parseInt(last4, 10);
		return `http://localhost:${port}`;
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
