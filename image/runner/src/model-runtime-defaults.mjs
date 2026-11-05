// Kept dependency-free: the child preload imports this in every Node process of a job.
export const DISCARDING_MODELS_STORE = Object.freeze({
	async read() { return undefined; },
	async write() {},
	async delete() {},
});

/** Give independently created runtimes the job's overlay when they did not choose a models path. */
export function installDefaultModelsPath(ModelRuntime, modelsPath) {
	const original = ModelRuntime.create;
	function create(options = {}) {
		if (options.modelsPath !== undefined) return original.call(this, options);
		return original.call(this, { ...options, modelsPath, ...(options.modelsStore === undefined && options.modelsStorePath === undefined ? { modelsStore: DISCARDING_MODELS_STORE } : {}) });
	}
	ModelRuntime.create = create;
	return { uninstall() { if (ModelRuntime.create === create) ModelRuntime.create = original; } };
}
