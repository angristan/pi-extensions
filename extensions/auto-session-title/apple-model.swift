import Foundation
import FoundationModels
import RegexBuilder

struct TitleRequest: Decodable {
    let systemPrompt: String
    let prompt: String
}

@Generable
struct TitleResponse {
    @Guide(description: "One concrete sentence summarizing the current request and outcome, at most 300 characters")
    let turn_summary: String

    @Guide(description: "The durable session-level project, objective, or deliverable, at most 600 characters")
    let focus_summary: String

    @Guide(Regex {
        OneOrMore(.word)
        Repeat(0...2) {
            " "
            OneOrMore(.word)
        }
    })
    let title: String
}

@main
struct AppleTitleHelper {
    static func main() async throws {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let request = try JSONDecoder().decode(TitleRequest.self, from: input)
        let model = SystemLanguageModel.default

        guard case .available = model.availability else {
            throw NSError(
                domain: "AutoSessionTitle",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Apple Foundation Model unavailable: \(model.availability)"]
            )
        }

        let session = LanguageModelSession(model: model) {
            request.systemPrompt
        }
        let options = GenerationOptions(
            sampling: .greedy,
            maximumResponseTokens: 256
        )
        let response = try await session.respond(
            to: request.prompt,
            generating: TitleResponse.self,
            options: options
        )
        let content = response.content
        let output = try JSONSerialization.data(withJSONObject: [
            "turn_summary": content.turn_summary,
            "focus_summary": content.focus_summary,
            "title": content.title,
        ], options: [.sortedKeys])

        FileHandle.standardOutput.write(output)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}
