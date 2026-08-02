import React, { useEffect, useMemo, useState } from "react";
import "./styles/main.css";
import defaultAvatar from "assets/images/profile-picture-girl-1.jpeg";
import Icon from "components/Icon";
import Alert from "./Alert";
import Contact from "./Contact";
import OptionsBtn from "components/OptionsButton";
import { useUsersContext } from "context/usersContext";
import { useSocketContext } from "context/socketContext";

const Sidebar = () => {
	const { users: contacts } = useUsersContext();
	const api = useSocketContext();
	const [me, setMe] = useState({ pushname: "Loading...", phone: "" });
	const [searchQuery, setSearchQuery] = useState("");

	useEffect(() => {
		let cancelled = false;
		const fetchMe = async () => {
			try {
				const data = await api.fetchMe();
				if (!cancelled && data.ok && data.result) {
					setMe(data.result);
				} else if (!cancelled) {
					setMe({ pushname: api.account, phone: "" });
				}
			} catch (err) {
				console.error("Failed to fetch user info:", err);
				if (!cancelled) setMe({ pushname: api.account, phone: "" });
			}
		};
		fetchMe();
		return () => {
			cancelled = true;
		};
	}, [api, api.account]);

	// Filter contacts by search query
	const filteredContacts = contacts.filter((contact) => {
		if (!searchQuery.trim()) return true;
		const query = searchQuery.toLowerCase();
		const name = (contact.name || "").toLowerCase();
		const phone = (contact.phone_number || "").toLowerCase();
		return name.includes(query) || phone.includes(query);
	});

	const menuOptions = useMemo(() => {
		const accountOptions = (api.accounts || []).map((entry) => {
			const mark = entry.id === api.account ? "✓ " : "   ";
			const ready = entry.ready ? "ready" : (entry.phase || "offline");
			const name = entry.description || entry.alias || entry.id;
			return {
				label: `${mark}${name} · ${entry.alias || entry.id} (${ready})`,
				className: entry.id === api.account ? "options-btn__option--active" : "",
				onSelect: () => {
					if (entry.id !== api.account) {
						api.setAccount(entry.id);
						// Full reload keeps chat state clean after account switch.
						window.location.assign(`/?account=${encodeURIComponent(entry.id)}`);
					}
				},
			};
		});

		return [
			{ label: "Switch account", disabled: true, className: "options-btn__option--heading" },
			...accountOptions,
			{ label: "──────────", disabled: true, className: "options-btn__option--divider" },
			"New group",
			"Profile",
			"Archived",
			"Starred",
			"Settings",
		];
	}, [api]);

	const activeAccountLabel = useMemo(() => {
		const entry = (api.accounts || []).find((a) => a.id === api.account);
		if (entry) return entry.description || entry.alias || entry.id;
		return me.pushname || api.account;
	}, [api.account, api.accounts, me.pushname]);

	return (
		<aside className="sidebar">
			<header className="header">
				<div className="sidebar__avatar-wrapper" title={activeAccountLabel}>
					<img src={defaultAvatar} alt={activeAccountLabel || "Me"} className="avatar" />
				</div>
				<div className="sidebar__account-meta" title={me.phone || api.account}>
					<span className="sidebar__account-name">{activeAccountLabel}</span>
					<span className="sidebar__account-id">{me.phone || api.account}</span>
				</div>
				<div className="sidebar__actions">
					<button className="sidebar__action" aria-label="Status">
						<Icon
							id="status"
							className="sidebar__action-icon sidebar__action-icon--status"
						/>
					</button>
					<button className="sidebar__action" aria-label="New chat">
						<Icon id="chat" className="sidebar__action-icon" />
					</button>
					<OptionsBtn
						className="sidebar__action"
						ariaLabel="Menu"
						iconId="menu"
						iconClassName="sidebar__action-icon"
						options={menuOptions}
					/>
				</div>
			</header>
			<Alert />
			<div className="search-wrapper">
				<div className="search-icons">
					<Icon id="search" className="search-icon" />
					<button className="search__back-btn" onClick={() => setSearchQuery("")}>
						<Icon id="back" />
					</button>
				</div>
				<input
					className="search"
					placeholder="Search or start a new chat"
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
				/>
			</div>
			<div className="sidebar__contacts">
				{filteredContacts.map((contact, index) => (
					<Contact key={contact.id || index} contact={contact} />
				))}
			</div>
		</aside>
	);
};

export default Sidebar;
