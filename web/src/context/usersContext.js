import { createContext, useContext, useEffect, useState } from "react";
import { useSocketContext } from "./socketContext";

const UsersContext = createContext();

const useUsersContext = () => useContext(UsersContext);

const UsersProvider = ({ children }) => {
	const api = useSocketContext();

	const [users, setUsers] = useState([]);
	const [loading, setLoading] = useState(true);

	// Fetch chats on mount
	useEffect(() => {
		const loadChats = async () => {
			try {
				const chats = await api.fetchChats();
				// Transform to UI format
				const formattedUsers = chats.map((chat) => ({
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
				setUsers(formattedUsers);
			} catch (err) {
				console.error('Failed to load chats:', err);
			} finally {
				setLoading(false);
			}
		};
		loadChats();
	}, [api]);

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

	const loadMessages = async (userId) => {
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
						id: msg.id
					});
				});
				usersCopy[userIndex].messages = grouped;
				return usersCopy;
			});
		} catch (err) {
			console.error('Failed to load messages:', err);
		}
	};

	const setUserAsUnread = (userId) => {
		_updateUserProp(userId, "unread", 0);
		// Load messages when chat is opened
		loadMessages(userId);
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
