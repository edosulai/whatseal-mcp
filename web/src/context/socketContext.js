import { createContext, useContext } from "react";

const API_URL = "http://localhost:5001";

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
