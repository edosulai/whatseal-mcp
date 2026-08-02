import React, { useEffect, useRef, useState } from "react";
import Icon from "components/Icon";
import "./styles/main.css";

/**
 * options: string[] | { label: string, onSelect?: () => void, disabled?: boolean, className?: string }[]
 */
const OptionsBtn = ({
	className,
	iconId,
	iconClassName,
	ariaLabel,
	options = [],
	position = "left",
	showPressed = true,
	...props
}) => {
	const [showOptions, setShowOptions] = useState(false);
	const rootRef = useRef(null);

	useEffect(() => {
		if (!showOptions) return undefined;
		const onDocClick = (event) => {
			if (rootRef.current && !rootRef.current.contains(event.target)) {
				setShowOptions(false);
			}
		};
		const onKey = (event) => {
			if (event.key === "Escape") setShowOptions(false);
		};
		document.addEventListener("mousedown", onDocClick);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDocClick);
			document.removeEventListener("keydown", onKey);
		};
	}, [showOptions]);

	const handleSelect = (option) => {
		if (typeof option === "string") {
			setShowOptions(false);
			return;
		}
		if (option?.disabled) return;
		setShowOptions(false);
		if (typeof option?.onSelect === "function") option.onSelect();
	};

	return (
		<div className="pos-rel" ref={rootRef}>
			<button
				aria-label={ariaLabel}
				className={`options-btn ${
					showOptions && showPressed ? "options-btn--pressed" : ""
				} ${className || ""}`}
				onClick={() => setShowOptions(!showOptions)}
				{...props}
			>
				<Icon id={iconId} className={iconClassName} />
			</button>
			<ul
				className={`options-btn__options ${
					showOptions ? "options-btn__options--active" : ""
				} ${position === "right" ? "options-btn__options--right" : ""}`}
			>
				{options.map((option, index) => {
					const label = typeof option === "string" ? option : option.label;
					const disabled = typeof option === "object" && option.disabled;
					const extraClass = typeof option === "object" ? option.className || "" : "";
					return (
						<li
							className={`options-btn__option ${disabled ? "options-btn__option--disabled" : ""} ${extraClass}`}
							key={`${label}-${index}`}
							onClick={() => handleSelect(option)}
							role="menuitem"
						>
							{label}
						</li>
					);
				})}
			</ul>
		</div>
	);
};

export default OptionsBtn;
