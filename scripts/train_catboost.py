#!/usr/bin/env python3
import argparse
import json
import sys

import numpy as np
import pandas as pd
from catboost import CatBoostClassifier, Pool
from sklearn.model_selection import StratifiedKFold, train_test_split

CV_FOLDS = 5


def _safe_kfold_cv(X, y, iterations, depth, learning_rate, folds):
    """分层 K-fold CV,样本/类别不足时自动降级。返回 (cv_acc, n_folds)。"""
    n = len(y)
    n_classes = len(np.unique(y))
    max_folds = max(2, n // max(1, n_classes))
    k = min(folds, max_folds)
    if k < 2 or n < 4:
        return None, 0
    try:
        skf = StratifiedKFold(n_splits=k, shuffle=True, random_state=42)
        accs = []
        for tr_idx, va_idx in skf.split(X, y):
            X_tr, X_va = X.iloc[tr_idx], X.iloc[va_idx]
            y_tr, y_va = y.iloc[tr_idx], y.iloc[va_idx]
            # 每折用 20% 做 early stopping eval_set
            X_tr_inner, X_es, y_tr_inner, y_es = train_test_split(
                X_tr, y_tr, test_size=0.2, random_state=42
            )
            fold_model = CatBoostClassifier(
                loss_function="MultiClass",
                iterations=iterations,
                depth=depth,
                learning_rate=learning_rate,
                verbose=False,
                random_seed=42,
            )
            fold_model.fit(
                Pool(X_tr_inner, y_tr_inner),
                eval_set=Pool(X_es, y_es),
                verbose=False,
            )
            preds = fold_model.predict(X_va).flatten()
            accs.append(float((preds == y_va.values).mean()))
        return float(np.mean(accs)), k
    except Exception:
        return None, 0


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

    # Hold out 20% for early stopping (or use provided test CSV)
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

    # Train accuracy (拟合程度, 在全量训练数据上)
    full_train_preds = model.predict(X).flatten()
    train_accuracy = float((full_train_preds == y.values).mean())

    # K-fold CV (泛化估计, 每折独立训练, 内部用 20% 做 early stopping)
    cv_acc, cv_k = _safe_kfold_cv(
        X, y, args.iterations, args.depth, args.learning_rate, CV_FOLDS,
    )

    result = {
        "modelOut": args.model_out,
        "iterations": model.tree_count_,
        "accuracy": train_accuracy,
        "cvAccuracy": cv_acc,
        "cvFolds": cv_k,
        "featureImportance": dict(zip(feature_cols, model.get_feature_importance().tolist())),
    }

    if args.feature_importance_out:
        with open(args.feature_importance_out, "w") as f:
            json.dump(result["featureImportance"], f, indent=2)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
