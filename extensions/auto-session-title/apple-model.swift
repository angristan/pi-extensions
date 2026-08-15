import Foundation
import FoundationModels

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

    @Guide(description: "A specific title-case noun phrase with at most three words and no punctuation")
    let title: String
}

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
let response = try await session.respond(to: request.prompt, generating: TitleResponse.self)
let content = response.content
let output = try JSONSerialization.data(withJSONObject: [
    "turn_summary": content.turn_summary,
    "focus_summary": content.focus_summary,
    "title": content.title,
], options: [.sortedKeys])

FileHandle.standardOutput.write(output)
FileHandle.standardOutput.write(Data("\n".utf8))
