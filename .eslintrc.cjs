module.exports = {
    extends: [
        "eslint:recommended",
        "plugin:@typescript-eslint/recommended",
        "plugin:@typescript-eslint/recommended-requiring-type-checking",
    ],
    plugins: [
        "@typescript-eslint"
    ],
    parser: "@typescript-eslint/parser",
    parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
    },
    root: true,
    rules: {
        "@typescript-eslint/no-unused-vars": "off",
        "no-unused-vars": [
            1,
            {
                argsIgnorePattern: "^_"
            }
        ],
        "max-len": [
            1,
            {
                code: 100,
            }
        ]
    }
}
