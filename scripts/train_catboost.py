#!/usr/bin/env python3
import argparse
import json
import sys

import pandas as pd
from catboost import CatBoostClassifier, Pool


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

    # If a separate test CSV is provided, use it as the eval set;
    # otherwise hold out 20% of the training data for accuracy estimation.
    if args.test_csv:
        train_df = df
        test_df = pd.read_csv(args.test_csv)
    else:
        df_shuffled = df.sample(frac=1.0, random_state=42).reset_index(drop=True)
        holdout_n = max(1, int(len(df_shuffled) * 0.2))
        test_df = df_shuffled.iloc[:holdout_n]
        train_df = df_shuffled.iloc[holdout_n:]

    X_train = train_df[feature_cols]
    y_train = train_df["label"].astype(int)
    X_test = test_df[feature_cols]
    y_test = test_df["label"].astype(int)

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

    # Compute holdout accuracy without sklearn — pure CatBoost + pandas
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
