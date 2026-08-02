import React, { useEffect, useState } from "react";
import "./App.css";
import { BrowserRouter as Router, Route, Switch } from "react-router-dom";
import Loader from "./components/Loader";
import Home from "./pages/Home";
import Sidebar from "components/Sidebar";
import Chat from "pages/Chat";
import Pairing from "pages/Pairing";
import { useSocketContext } from "context/socketContext";

const userPrefersDark =
	window.matchMedia &&
	window.matchMedia("(prefers-color-scheme: dark)").matches;

function App() {
	const api = useSocketContext();
	const [appLoaded, setAppLoaded] = useState(false);
	const [startLoadProgress, setStartLoadProgress] = useState(false);
	const [waStatus, setWaStatus] = useState({ phase: "loading", ready: false });

	useEffect(() => {
		if (userPrefersDark) document.body.classList.add("dark-theme");
		stopLoad();
	}, []);

	// Check WhatsApp status for the selected account (via gateway header).
	useEffect(() => {
		let cancelled = false;
		const checkStatus = async () => {
			try {
				const data = await api.fetchStatus();
				if (!cancelled && data.ok) {
					setWaStatus(data.result);
				}
			} catch (err) {
				if (!cancelled) setWaStatus({ phase: "error", ready: false });
			}
		};
		checkStatus();
		const interval = setInterval(checkStatus, 3000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [api, api.account]);

	const stopLoad = () => {
		setStartLoadProgress(true);
		setTimeout(() => setAppLoaded(true), 3000);
	};

	if (!appLoaded) return <Loader done={startLoadProgress} />;

	// Show pairing screen if not ready
	if (waStatus.phase === "pairing") {
		return (
			<div className="app">
				<Pairing />
			</div>
		);
	}

	return (
		<div className="app">
			<p className="app__mobile-message"> Only available on desktop 😊. </p>
			<Router>
				<div className="app-content">
					<Sidebar />
					<Switch>
						<Route path="/chat/:id" component={Chat} />
						<Route component={Home} />
					</Switch>
				</div>
			</Router>
		</div>
	);
}

export default App;
