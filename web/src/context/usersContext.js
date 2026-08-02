import { createContext, useContext, useEffect, useState, useRef, useCallback } from "react";
import { useSocketContext } from "./socketContext";

const UsersContext = createContext();

const useUsersContext = () => useContext(UsersContext);

const UsersProvider = ({ children }) => {
	const api = useSocketContext();

	const [users, setUsers] = useState([]);
	const [loading, setLoading] = useState(true);
	const [activeChat, setActiveChat] = useState(null);
	const pollIntervalRef = useRef(null);

	// Transform API response to UI format
	const transformChats = useCallback((chats) => {
		return chats.map((chat) => ({
			id: chat.id,
			name: chat.name || chat.id,
			profile_picture: null,
			phone_number: chat.id,
			unread: chat.unread || 0,
			typing: false,
			isGroup: chat.isGroup,
			messages: { TODAY: [] },
			lastMessage: chat.lastMessage || '',
			timestamp: chat.timestamp
		}));
	}, []);

	// Fetch chats function
	const loadChats = useCallback(async (preserveMessages = false) => {
		try {
			const chats = await api.fetchChats();
			const formattedUsers = transformChats(chats);
			
			setUsers((prevUsers) => {
				if (!preserveMessages) return formattedUsers;
				// Preserve loaded messages for existing users
				return formattedUsers.map(newUser => {
					const existingUser = prevUsers.find(u => u.id === newUser.id);
					if (existingUser && existingUser.messages.TODAY.length > 0) {
						return { ...newUser, messages: existingUser.messages };
					}
					return newUser;
				});
			});
		} catch (err) {
			console.error('Failed to load chats:', err);
		} finally {
			setLoading(false);
		}
	}, [api, transformChats]);

	// Initial load and polling (rebind when account changes via api identity).
	useEffect(() => {
		setLoading(true);
		setUsers([]);
		setActiveChat(null);
		loadChats(false);

		// Poll every 5 seconds for new chats/messages
		pollIntervalRef.current = setInterval(() => {
			loadChats(true);
		}, 5000);

		return () => {
			if (pollIntervalRef.current) {
				clearInterval(pollIntervalRef.current);
			}
		};
	}, [loadChats, api.account]);

	const _updateUserProp = (userId, prop, value) => {
		setUsers((users) => {
			const usersCopy = [...users];
			let userIndex = users.findIndex((user) => user.id === userId);
			if (userIndex === -1) return users;
			const userObject = usersCopy[userIndex];
			usersCopy[userIndex] = { ...userObject, [prop]: value };
			return usersCopy;
		});
	};

	const setUserAsTyping = (data) => {
		const { userId } = data;
		_updateUserProp(userId, "typing", true);
	};

	const setUserAsNotTyping = (data) => {
		const { userId } = data;
		_updateUserProp(userId, "typing", false);
	};

	const loadMessages = useCallback(async (userId) => {
		if (!userId) return;
		try {
			const messages = await api.fetchMessages(userId);
			setUsers((users) => {
				const usersCopy = JSON.parse(JSON.stringify(users));
				let userIndex = users.findIndex((user) => user.id === userId);
				if (userIndex === -1) return users;
				
				// Group messages by date
				const grouped = { TODAY: [] };
				messages.forEach(msg => {
					grouped.TODAY.push({
						content: msg.content,
						sender: msg.sender,
						time: msg.time,
						status: msg.status,
						id: msg.id,
						type: msg.type,
						hasMedia: msg.hasMedia,
						mediaUrl: msg.mediaUrl
					});
				});
				usersCopy[userIndex].messages = grouped;
				return usersCopy;
			});
		} catch (err) {
			console.error('Failed to load messages:', err);
		}
	}, [api]);

	// Poll active chat messages more frequently
	useEffect(() => {
		if (!activeChat) return;
		
		// Load immediately when chat changes
		loadMessages(activeChat);
		
		const msgPollInterval = setInterval(() => {
			loadMessages(activeChat);
		}, 2000); // Poll every 2 seconds

		return () => clearInterval(msgPollInterval);
	}, [activeChat, loadMessages]);

	const setUserAsUnread = (userId) => {
		_updateUserProp(userId, "unread", 0);
		setActiveChat(userId);
	};

	const addNewMessage = async (userId, message) => {
		// Add to local state immediately
		setUsers((users) => {
			let userIndex = users.findIndex((user) => user.id === userId);
			if (userIndex === -1) return users;
			const usersCopy = JSON.parse(JSON.stringify(users));
			const newMsgObject = {
				content: message,
				sender: null,
				time: new Date().toLocaleTimeString(),
				status: "sending",
			};
			usersCopy[userIndex].messages.TODAY.push(newMsgObject);
			return usersCopy;
		});

		// Send via API
		try {
			await api.sendMessage(userId, message);
			// Update status to delivered
			setUsers((users) => {
				let userIndex = users.findIndex((user) => user.id === userId);
				if (userIndex === -1) return users;
				const usersCopy = JSON.parse(JSON.stringify(users));
				const msgs = usersCopy[userIndex].messages.TODAY;
				if (msgs.length > 0) {
					msgs[msgs.length - 1].status = "delivered";
				}
				return usersCopy;
			});
		} catch (err) {
			console.error('Failed to send message:', err);
		}
	};

	return (
		<UsersContext.Provider value={{ users, setUserAsUnread, addNewMessage, loading }}>
			{children}
		</UsersContext.Provider>
	);
};

export { useUsersContext, UsersProvider };
