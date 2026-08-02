import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

// Single public gateway. User never picks ports — only account id.
// Dev: CRA proxies /api → gateway :3000 (or REACT_APP_API_URL).
// Prod: same origin as the SPA, or REACT_APP_API_URL override.
const STORAGE_KEY = "whatsealAccount";

function resolveApiUrl() {
	if (process.env.REACT_APP_API_URL) return process.env.REACT_APP_API_URL.replace(/\/$/, "");
	// Same-origin relative API when served via gateway static, or CRA proxy.
	return "";
}

function readStoredAccount() {
	try {
		const params = new URLSearchParams(window.location.search);
		const fromQuery = params.get("account");
		if (fromQuery) {
			localStorage.setItem(STORAGE_KEY, fromQuery);
			return fromQuery;
		}
		return localStorage.getItem(STORAGE_KEY) || "alpha";
	} catch (_) {
		return "alpha";
	}
}

const SocketContext = createContext();

const useSocketContext = () => useContext(SocketContext);

const SocketProvider = ({ children }) => {
	const baseUrl = useMemo(() => resolveApiUrl(), []);
	const [account, setAccountState] = useState(readStoredAccount);
	const [accounts, setAccounts] = useState([]);
	const [accountsMeta, setAccountsMeta] = useState({ default: "alpha", selected: account });

	const setAccount = useCallback((nextId) => {
		if (!nextId) return;
		localStorage.setItem(STORAGE_KEY, nextId);
		setAccountState(nextId);
		// Keep URL shareable without multi-port confusion.
		try {
			const url = new URL(window.location.href);
			url.searchParams.set("account", nextId);
			window.history.replaceState({}, "", url.toString());
		} catch (_) { /* ignore */ }
	}, []);

	const accountHeaders = useCallback(() => ({
		"Content-Type": "application/json",
		"X-Whatseal-Account": account,
	}), [account]);

	const apiPath = useCallback((path) => {
		const clean = path.startsWith("/") ? path : `/${path}`;
		return `${baseUrl}${clean}`;
	}, [baseUrl]);

	const fetchJson = useCallback(async (path, options = {}) => {
		const headers = {
			...accountHeaders(),
			...(options.headers || {}),
		};
		// GET may omit Content-Type body; still send account header.
		if (options.method === "GET" || !options.method) {
			delete headers["Content-Type"];
		}
		const res = await fetch(apiPath(path), { ...options, headers });
		return res.json();
	}, [accountHeaders, apiPath]);

	const refreshAccounts = useCallback(async () => {
		try {
			const data = await fetchJson("/api/accounts");
			if (data?.ok && data.result) {
				setAccounts(data.result.accounts || []);
				setAccountsMeta({
					default: data.result.default,
					selected: data.result.selected,
				});
				// If stored account missing from config, fall back to default.
				const ids = (data.result.accounts || []).map((a) => a.id);
				if (ids.length && !ids.includes(account)) {
					setAccount(data.result.default || ids[0]);
				}
			}
		} catch (err) {
			console.error("Failed to load accounts:", err);
		}
	}, [account, fetchJson, setAccount]);

	useEffect(() => {
		refreshAccounts();
		const interval = setInterval(refreshAccounts, 10000);
		return () => clearInterval(interval);
	}, [refreshAccounts]);

	const api = useMemo(() => ({
		baseUrl,
		account,
		accounts,
		accountsMeta,
		setAccount,
		refreshAccounts,
		// Absolute helper for media/QR img tags (same origin + account query).
		mediaUrl(path) {
			if (!path) return null;
			if (/^https?:\/\//i.test(path)) return path;
			const url = new URL(apiPath(path), window.location.origin);
			url.searchParams.set("account", account);
			return url.toString();
		},
		async fetchChats() {
			return fetchJson("/api/chats");
		},
		async fetchMessages(chatId, limit = 50) {
			return fetchJson(`/api/messages/${encodeURIComponent(chatId)}?limit=${limit}`);
		},
		async sendMessage(chatId, text) {
			return fetchJson("/api/send", {
				method: "POST",
				body: JSON.stringify({ chatId, text }),
			});
		},
		async fetchStatus() {
			return fetchJson("/api/status");
		},
		async fetchMe() {
			return fetchJson("/api/me");
		},
		async fetchQr() {
			return fetchJson("/api/qr");
		},
	}), [account, accounts, accountsMeta, baseUrl, fetchJson, refreshAccounts, setAccount, apiPath]);

	return (
		<SocketContext.Provider value={api}>{children}</SocketContext.Provider>
	);
};

export { useSocketContext, SocketProvider };
