#!/usr/bin/env python3
import argparse
import json
import sys

import pandas as pd
from catboost import CatBoostClassifier, Pool
from sklearn.model_selection import train_test_split


def main():
    parser = argparse.ArgumentParser(description="Train a CatBoost model for model-size recommendation.")
    parser.add_argument("--train-csv", required=True, help="Path to training CSV")
    parser.add_argument("--test-csv", help="Path to test CSV (optional)")
    parser.add_argument("--model-out", required=True, help="Path to write the trained model (.cbm)")
    parser.add_argument("--feature-importance-out", help="Path to write feature importance JSON")
    parser.add_argument("--iterations", type=int, default=200)
    parser.add_argument("--depth", type=int, default=6)
    parser.add_argument("--learning-rate", type=float, default=0.1)
    args = parser.parse_args()

    df = pd.read_csv(args.train_csv)
    if "label" not in df.columns:
        print("Error: CSV must contain a 'label' column", file=sys.stderr)
        sys.exit(1)

    feature_cols = [c for c in df.columns if c != "label"]
    X = df[feature_cols]
    y = df["label"].astype(int)

    # Hold out 20% for accuracy estimation (or use provided test CSV)
    if args.test_csv:
        test_df = pd.read_csv(args.test_csv)
        X_train, y_train = X, y
        X_test, y_test = test_df[feature_cols], test_df["label"].astype(int)
    else:
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    train_pool = Pool(data=X_train, label=y_train)
    test_pool = Pool(data=X_test, label=y_test)

    model = CatBoostClassifier(
        loss_function="MultiClass",
        iterations=args.iterations,
        depth=args.depth,
        learning_rate=args.learning_rate,
        verbose=False,
        random_seed=42,
    )

    model.fit(train_pool, eval_set=test_pool, verbose=False)
    model.save_model(args.model_out)

    preds = model.predict(X_test).flatten()
    accuracy = float((preds == y_test.values).mean())

    result = {
        "modelOut": args.model_out,
        "iterations": model.tree_count_,
        "accuracy": accuracy,
        "featureImportance": dict(zip(feature_cols, model.get_feature_importance().tolist())),
    }

    if args.feature_importance_out:
        with open(args.feature_importance_out, "w") as f:
            json.dump(result["featureImportance"], f, indent=2)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
