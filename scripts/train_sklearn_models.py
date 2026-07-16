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
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.naive_bayes import GaussianNB
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler, FunctionTransformer

# Must match NaiveBayesModel.LOG_TRANSFORM_COLS in src/ml/NaiveBayesModel.ts
LOG_TRANSFORM_COLS = {
    'promptTokens', 'completionTokens', 'contextTokens',
    'toolCalls', 'readFiles', 'edits', 'retries',
    'uniqueFilesRead', 'uniqueFilesEdited', 'elapsedMs',
    'chatDurationMs', 'toolDurationMs', 'idleMs',
    'rollingAvgTokens', 'rollingAvgDuration', 'emaTokens',
}

NUM_CLASSES = 3
# 小数据集用 5 折分层 CV;若某折只有 1 类则降级到 3 折或跳过
CV_FOLDS = 5


def make_log_transformer(feature_cols):
    """构造一个对 LOG_TRANSFORM_COLS 列做 log1p 的 FunctionTransformer。"""
    log_idx = [i for i, c in enumerate(feature_cols) if c in LOG_TRANSFORM_COLS]

    def log_transform(X):
        X = np.asarray(X, dtype=float).copy()
        if X.ndim == 1:
            X = X.reshape(1, -1)
        for i in log_idx:
            X[:, i] = np.log1p(np.maximum(X[:, i], 0))
        return X

    return FunctionTransformer(log_transform, validate=False)


def apply_log_transform(X, feature_cols):
    """Apply log(1+x) to count-based features (in-place on a copy)."""
    X = X.copy()
    for i, c in enumerate(feature_cols):
        if c in LOG_TRANSFORM_COLS:
            X[:, i] = np.log1p(X[:, i])
    return X


def _safe_cv_score(pipeline, X, y, folds):
    """分层 K-fold CV,样本数或类别不足时自动降级。返回 (cv_acc, n_folds_used)。"""
    n = len(y)
    n_classes = len(np.unique(y))
    # 每折每类至少 1 个样本
    max_folds = max(2, n // max(1, n_classes))
    k = min(folds, max_folds)
    if k < 2 or n < 4:
        return None, 0
    try:
        skf = StratifiedKFold(n_splits=k, shuffle=True, random_state=42)
        scores = cross_val_score(pipeline, X, y, cv=skf, scoring='accuracy')
        return float(np.mean(scores)), k
    except Exception:
        return None, 0


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

    # K-fold CV — 用 Pipeline 防止 log transform 在折内/折外泄露
    cv_pipeline = Pipeline([
        ('log', make_log_transformer(feature_cols)),
        ('nb', GaussianNB(var_smoothing=1e-6)),
    ])
    cv_acc, cv_k = _safe_cv_score(cv_pipeline, df[feature_cols].values.astype(float), y, CV_FOLDS)

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

    return accuracy, cv_acc, cv_k, importance


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

    # K-fold CV — 用 Pipeline 防止 StandardScaler 泄露
    cv_pipeline = Pipeline([
        ('scaler', StandardScaler()),
        ('lr', LogisticRegression(solver='lbfgs', C=100.0, max_iter=500, random_state=42)),
    ])
    cv_acc, cv_k = _safe_cv_score(cv_pipeline, X, y, CV_FOLDS)

    # Feature importance: mean abs weight across classes
    importance = {}
    for f, col in enumerate(feature_cols):
        importance[col] = float(np.mean(np.abs(model.coef_[:, f])))

    return accuracy, cv_acc, cv_k, importance


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
        nb_acc, nb_cv, nb_cvk, nb_imp = train_nb(df, feature_cols, nb_path)
        result['naivebayes'] = {
            'path': nb_path, 'accuracy': nb_acc, 'trainSamples': len(df),
            'cvAccuracy': nb_cv, 'cvFolds': nb_cvk,
            'featureImportance': nb_imp,
        }

    if args.model in ('lr', 'both'):
        lr_path = args.lr_out or f'{out_dir}/logistic-model.json'
        lr_acc, lr_cv, lr_cvk, lr_imp = train_lr(df, feature_cols, lr_path)
        result['logistic'] = {
            'path': lr_path, 'accuracy': lr_acc, 'trainSamples': len(df),
            'cvAccuracy': lr_cv, 'cvFolds': lr_cvk,
            'featureImportance': lr_imp,
        }

    print(json.dumps(result))


if __name__ == '__main__':
    main()
