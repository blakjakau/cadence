const app = {
	folders: [],
	workspaces: ["default", "new_workspace"],
	sessionOptions: {},
	rendererOptions: {},
	enableLiveAutocompletion: true,
	darkmode: "system",
	aiConfig: {},
	systemPromptConfig: {},
	workspace: "new_workspace"
};
fetch("http://localhost:3023/api/config", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(app)
}).then(async r => {
	console.log(r.status, await r.text());
}).catch(console.error);
