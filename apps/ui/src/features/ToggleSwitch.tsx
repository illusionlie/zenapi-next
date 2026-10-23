/**
 * 滑块开关:视觉替换 checkbox,内部保留原生 input(sr-only)承接
 * 键盘焦点 / 读屏 / 受控 onChange,外层由调用方的 <label> 提供关联文本。
 */
export const ToggleSwitch = ({
	id,
	checked,
	disabled,
	onChange,
}: {
	id: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}) => (
	<span
		class={`relative inline-flex items-center ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
	>
		<input
			type="checkbox"
			id={id}
			class="peer sr-only"
			checked={checked}
			disabled={disabled}
			onChange={(event) => {
				const target = event.currentTarget as HTMLInputElement | null;
				onChange(target?.checked ?? false);
			}}
		/>
		<span class="h-6 w-11 rounded-full bg-stone-200 transition-colors duration-200 ease-smooth-out peer-checked:bg-amber-500 peer-focus-visible:ring-2 peer-focus-visible:ring-amber-400/70 peer-focus-visible:ring-offset-2 peer-disabled:opacity-60" />
		<span class="absolute left-1 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow transition-transform duration-200 ease-smooth-out peer-checked:translate-x-5 peer-disabled:opacity-60" />
	</span>
);
