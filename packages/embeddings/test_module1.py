from embedder import EmbeddingEngine


TEXTS = [
    ("t1", "Neural networks learn by adjusting weights through backpropagation."),
    ("t2", "Deep learning models require large datasets for effective training."),
    ("t3", "Transformer architecture uses self-attention mechanisms for NLP tasks."),
    ("t4", "Convolutional neural networks excel at image recognition and classification."),
    ("t5", "Gradient descent optimizes model parameters by minimizing the loss function."),
    ("t6", "The best pasta carbonara uses guanciale, eggs, and pecorino romano cheese."),
    ("t7", "Sourdough bread fermentation requires maintaining an active starter culture."),
    ("t8", "French cuisine emphasizes butter-based sauces and classical cooking techniques."),
    ("t9", "Sushi preparation involves vinegared rice combined with fresh raw fish."),
    ("t10", "Chocolate ganache is made by combining heavy cream with finely chopped chocolate."),
]

ML_IDS = {"t1", "t2", "t3", "t4", "t5"}
FOOD_IDS = {"t6", "t7", "t8", "t9", "t10"}


def print_results(label: str, results: list[dict]) -> None:
    print(f"\n--- {label} ---")
    for r in results:
        print(f"  [{r['score']:.4f}] {r['id']}: {r['text'][:75]}")


def test_semantic_search():
    print("Loading model (first run downloads ~80MB)...")
    engine = EmbeddingEngine()

    print("Indexing 10 texts...")
    for id, text in TEXTS:
        engine.add(id, text)
    print(f"Indexed {engine.index.size} fragments.\n")

    results_ml = engine.search("machine learning neural networks", top_k=3)
    print_results("Query: 'machine learning neural networks'", results_ml)
    top_ml = {r["id"] for r in results_ml}
    overlap_ml = top_ml & ML_IDS
    assert len(overlap_ml) >= 2, f"Expected ML results, got: {top_ml}"
    print(f"PASS: {len(overlap_ml)}/3 results are ML-related {overlap_ml}")

    results_food = engine.search("cooking pasta Italian food", top_k=3)
    print_results("Query: 'cooking pasta Italian food'", results_food)
    top_food = {r["id"] for r in results_food}
    overlap_food = top_food & FOOD_IDS
    assert len(overlap_food) >= 2, f"Expected food results, got: {top_food}"
    print(f"PASS: {len(overlap_food)}/3 results are food-related {overlap_food}")

    print("\nModule 1 — ALL TESTS PASSED.")


if __name__ == "__main__":
    test_semantic_search()
