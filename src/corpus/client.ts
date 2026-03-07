import { create_corpus, create_memory_backend } from "@f0rbit/corpus";
import { create_file_backend } from "@f0rbit/corpus/file";
import { rawAccountsStore, rawBalancesStore, rawTransactionsStore, syncResultsStore } from "./stores.js";

function buildCorpus(backend: ReturnType<typeof create_memory_backend>) {
	return create_corpus()
		.with_backend(backend)
		.with_store(rawTransactionsStore)
		.with_store(rawAccountsStore)
		.with_store(rawBalancesStore)
		.with_store(syncResultsStore)
		.build();
}

export type AppCorpus = ReturnType<typeof buildCorpus>;

export function createCorpus(dataDir: string) {
	const backend = create_file_backend({ base_path: dataDir });
	return buildCorpus(backend);
}

export function createTestCorpus() {
	const backend = create_memory_backend();
	return buildCorpus(backend);
}
