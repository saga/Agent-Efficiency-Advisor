#!/usr/bin/env python3
"""Train Gaussian NB and Logistic Regression with sklearn.

Exports JSON files whose format matches the TS predict() implementations in
NaiveBayesModel.ts and LogisticRegressionModel.ts, so prediction stays in TS
(no cross-process overhead at inference time).
"""
import argparse
import json
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.naive_bayes import GaussianNB
from sklearn.preprocessing import StandardScaler

# Must match NaiveBayesModel.LOG_TRANSFORM_COLS in src/ml/NaiveBayesModel.ts
LOG_TRANSFORM_COLS = {
    'promptTokens', 'completionTokens', 'contextTokens',
    'toolCalls', 'readFiles', 'edits', 'retries',
    'uniqueFilesRead', 'uniqueFilesEdited', 'elapsedMs',
    'chatDurationMs', 'toolDurationMs', 'idleMs',
    'rollingAvgTokens', 'rollingAvgDuration', 'emaTokens',
}

NUM_CLASSES = 3


def apply_log_transform(X, feature_cols):
    """Apply log(1+x) to count-based features (in-place on a copy)."""
    X = X.copy()
    for i, c in enumerate(feature_cols):
        if c in LOG_TRANSFORM_COLS:
            X[:, i] = np.log1p(X[:, i])
    return X


def train_nb(df, feature_cols, out_path):
    X = df[feature_cols].values.astype(float)
    y = df['label'].astype(int).values
    X = apply_log_transform(X, feature_cols)

    model = GaussianNB(var_smoothing=1e-6)
    model.fit(X, y)

    data = {
        'means': model.theta_.tolist(),
        'variances': model.var_.tolist(),
        'priors': model.class_prior_.tolist(),
    }
    with open(out_path, 'w') as f:
        json.dump(data, f)

    preds = model.predict(X)
    accuracy = float(np.mean(preds == y))

    # Feature importance: inter-class mean separation / avg std
    importance = {}
    for f, col in enumerate(feature_cols):
        sep = 0.0
        for c1 in range(NUM_CLASSES):
            for c2 in range(c1 + 1, NUM_CLASSES):
                if c1 < model.theta_.shape[0] and c2 < model.theta_.shape[0]:
                    diff = abs(model.theta_[c1, f] - model.theta_[c2, f])
                    avg_std = (np.sqrt(model.var_[c1, f]) + np.sqrt(model.var_[c2, f])) / 2 or 1.0
                    sep += diff / avg_std
        importance[col] = float(sep)

    return accuracy, importance


def train_lr(df, feature_cols, out_path):
    X = df[feature_cols].values.astype(float)
    y = df['label'].astype(int).values

    scaler = StandardScaler()
    X_norm = scaler.fit_transform(X)

    model = LogisticRegression(
        solver='lbfgs',
        C=100.0,  # 1 / l2Reg (0.01)
        max_iter=500,
        random_state=42,
    )
    model.fit(X_norm, y)

    data = {
        'weights': model.coef_.tolist(),
        'biases': model.intercept_.tolist(),
        'featureMeans': scaler.mean_.tolist(),
        'featureStds': scaler.scale_.tolist(),
        'iterations': 500,
        'learningRate': 0.01,
        'l2Reg': 0.01,
    }
    with open(out_path, 'w') as f:
        json.dump(data, f)

    preds = model.predict(X_norm)
    accuracy = float(np.mean(preds == y))

    # Feature importance: mean abs weight across classes
    importance = {}
    for f, col in enumerate(feature_cols):
        importance[col] = float(np.mean(np.abs(model.coef_[:, f])))

    return accuracy, importance


def main():
    parser = argparse.ArgumentParser(description="Train NB and LR with sklearn, export TS-compatible JSON.")
    parser.add_argument('--train-csv', required=True, help='Path to training CSV')
    parser.add_argument('--out-dir', help='Directory to write model JSONs (default: cwd)')
    parser.add_argument('--nb-out', help='Full output path for NB model JSON (overrides --out-dir)')
    parser.add_argument('--lr-out', help='Full output path for LR model JSON (overrides --out-dir)')
    parser.add_argument('--model', choices=['nb', 'lr', 'both'], default='both',
                        help='Which model to train (default: both)')
    args = parser.parse_args()

    df = pd.read_csv(args.train_csv)
    if 'label' not in df.columns:
        print("Error: CSV must contain a 'label' column", file=sys.stderr)
        sys.exit(1)

    feature_cols = [c for c in df.columns if c != 'label']
    out_dir = args.out_dir or '.'
    result = {}

    if args.model in ('nb', 'both'):
        nb_path = args.nb_out or f'{out_dir}/naivebayes-model.json'
        nb_acc, nb_imp = train_nb(df, feature_cols, nb_path)
        result['naivebayes'] = {'path': nb_path, 'accuracy': nb_acc, 'featureImportance': nb_imp, 'trainSamples': len(df)}

    if args.model in ('lr', 'both'):
        lr_path = args.lr_out or f'{out_dir}/logistic-model.json'
        lr_acc, lr_imp = train_lr(df, feature_cols, lr_path)
        result['logistic'] = {'path': lr_path, 'accuracy': lr_acc, 'featureImportance': lr_imp, 'trainSamples': len(df)}

    print(json.dumps(result))


if __name__ == '__main__':
    main()
